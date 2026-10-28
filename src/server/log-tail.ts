import { closeSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { WebSocket } from "ws";
import { ID, RUN_ID } from "../lib/jobs";
import { CLOSE } from "../lib/protocol";
import { getRun, logFile } from "./jobs";

const POLL_MS = 500;
/** A huge shell log starts from its tail; the browser only keeps so much. */
const MAX_BACKLOG = 2 << 20;
const CHUNK = 64 << 10;

/**
 * `tail -f` a run's output.log over a WebSocket: everything so far, then new
 * output as it lands. Closes with CLOSE.DETACHED once the run has finished
 * and the whole log is sent.
 */
export function attachLog(ws: WebSocket, params: URLSearchParams) {
  const jobId = params.get("job") ?? "";
  const runId = params.get("run") ?? "";
  if (!ID.test(jobId) || !RUN_ID.test(runId) || !getRun(jobId, runId)) {
    ws.close(CLOSE.NO_SESSION, "no such run");
    return;
  }
  const file = logFile(jobId, runId);
  let offset = -1;
  // A chunk can end mid-character; hold the partial bytes for the next one.
  const decoder = new StringDecoder("utf8");
  let timer: NodeJS.Timeout | undefined;

  const pump = () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    // Checked before reading, so output written just before it finished
    // still goes out before the close.
    const finished = getRun(jobId, runId)?.status !== "running";
    const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    if (offset < 0) offset = Math.max(0, size - MAX_BACKLOG);
    if (size > offset) {
      const fd = openSync(file, "r");
      try {
        const buf = Buffer.alloc(CHUNK);
        while (offset < size) {
          const n = readSync(
            fd,
            buf,
            0,
            Math.min(CHUNK, size - offset),
            offset,
          );
          if (n <= 0) break;
          ws.send(decoder.write(buf.subarray(0, n)));
          offset += n;
        }
      } finally {
        closeSync(fd);
      }
    }
    if (finished) {
      ws.close(CLOSE.DETACHED, "finished");
      return;
    }
    timer = setTimeout(pump, POLL_MS);
  };

  ws.on("close", () => clearTimeout(timer));
  pump();
}
