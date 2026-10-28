import { closeSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { WebSocket } from "ws";
import { CLOSE } from "../lib/protocol";
import { ID, RUN_ID } from "../lib/workflows";
import { getRun, logFile } from "./workflows";

const POLL_MS = 500;
/** A huge shell log starts from its tail; the browser only keeps so much. */
const MAX_BACKLOG = 2 << 20;
const CHUNK = 64 << 10;

/**
 * `tail -f` a run's output.log over a WebSocket: everything so far, then new
 * output as it lands. With `step`, only that step's bytes, waiting for it
 * to start. Closes with CLOSE.DETACHED once the run (or the step) is done
 * and all of it is sent.
 */
export function attachLog(ws: WebSocket, params: URLSearchParams) {
  const wfId = params.get("workflow") ?? "";
  const runId = params.get("run") ?? "";
  const stepParam = params.get("step");
  const step = stepParam === null ? null : Number(stepParam);
  const run = ID.test(wfId) && RUN_ID.test(runId) ? getRun(wfId, runId) : null;
  if (
    !run ||
    (step !== null && (!Number.isInteger(step) || !run.steps[step]))
  ) {
    ws.close(CLOSE.NO_SESSION, "no such run");
    return;
  }
  const file = logFile(wfId, runId);
  let offset = -1;
  // A chunk can end mid-character; hold the partial bytes for the next one.
  const decoder = new StringDecoder("utf8");
  let timer: NodeJS.Timeout | undefined;

  const send = (from: number, to: number) => {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(CHUNK);
      while (from < to) {
        const n = readSync(fd, buf, 0, Math.min(CHUNK, to - from), from);
        if (n <= 0) break;
        ws.send(decoder.write(buf.subarray(0, n)));
        from += n;
      }
    } finally {
      closeSync(fd);
    }
    return from;
  };

  // A throw in a timer would take the whole server down (the log can be
  // deleted mid-read); end this socket instead, and the client retries.
  const pump = () => {
    try {
      tail();
    } catch (err) {
      console.error(`[workflows] log ${wfId}/${runId}:`, err);
      ws.close(1011, "log read failed");
    }
  };

  const tail = () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    // Read before the log, so output written just before it finished
    // still goes out before the close.
    const now = getRun(wfId, runId);
    const finished = now?.status !== "running";
    const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    const s = step === null ? null : now?.steps[step];
    if (s && s.logStart === undefined) {
      if (finished) {
        ws.send("\x1b[2mThis step didn't run.\x1b[0m\r\n");
        ws.close(CLOSE.DETACHED, "finished");
        return;
      }
      timer = setTimeout(pump, POLL_MS);
      return;
    }
    const start = s?.logStart ?? 0;
    const end = Math.min(size, s?.logEnd ?? size);
    const done = finished || s?.logEnd !== undefined;
    if (offset < 0) offset = Math.max(start, end - MAX_BACKLOG);
    if (end > offset) offset = send(offset, end);
    if (done) {
      ws.close(CLOSE.DETACHED, "finished");
      return;
    }
    timer = setTimeout(pump, POLL_MS);
  };

  ws.on("close", () => clearTimeout(timer));
  pump();
}
