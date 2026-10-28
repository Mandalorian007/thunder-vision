import os from "node:os";
import { spawn } from "node-pty";
import { WebSocket } from "ws";
import { CLOSE, type ClientMessage } from "../lib/protocol";
import { cleanEnv, hasSession, TMUX_BIN } from "./tmux";

const HIGH_WATER = 1 << 20; // pause tmux output when 1MB is queued to a slow client
const PING_MS = 25_000;

function dim(value: string | null, fallback: number) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 2 && n <= 1000 ? n : fallback;
}

/**
 * Bridge one WebSocket to a fresh `tmux attach` client. Killing the pty only
 * detaches that client; the session itself is untouched.
 */
export async function attachPty(ws: WebSocket, params: URLSearchParams) {
  const name = params.get("session") ?? "";
  if (!(await hasSession(name))) {
    ws.close(CLOSE.NO_SESSION, "no such session");
    return;
  }

  const env = { ...cleanEnv(), TERM: "xterm-256color", COLORTERM: "truecolor" };
  // "=" forces an exact session-name match instead of tmux's prefix matching.
  const pty = spawn(TMUX_BIN, ["-u", "attach-session", "-t", `=${name}`], {
    name: "xterm-256color",
    cols: dim(params.get("cols"), 80),
    rows: dim(params.get("rows"), 24),
    cwd: os.homedir(),
    env,
  });

  let paused = false;
  const drain = () => {
    if (ws.bufferedAmount < HIGH_WATER / 4) {
      paused = false;
      pty.resume();
    } else {
      setTimeout(drain, 20);
    }
  };

  pty.onData((data) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(data);
    if (!paused && ws.bufferedAmount > HIGH_WATER) {
      paused = true;
      pty.pause();
      setTimeout(drain, 20);
    }
  });

  pty.onExit(() => {
    if (ws.readyState === WebSocket.OPEN) ws.close(CLOSE.DETACHED, "detached");
  });

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.t === "i" && typeof msg.d === "string") {
      pty.write(msg.d);
    } else if (msg.t === "r") {
      pty.resize(
        dim(String(msg.cols), pty.cols),
        dim(String(msg.rows), pty.rows),
      );
    }
  });

  // Phones drop connections silently; ping so dead sockets get reaped.
  let alive = true;
  ws.on("pong", () => (alive = true));
  const ping = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, PING_MS);

  ws.on("close", () => {
    clearInterval(ping);
    pty.kill();
  });
}
