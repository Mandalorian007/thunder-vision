// Runs one scheduled job, detached from the server: `node --import tsx
// job-runner.ts <run folder>`. Reads spec.json, writes output.log (what the
// live log tails; Claude's stream is turned into readable lines), raw.jsonl
// (Claude's stream as-is) and the final state into run.json.
//
// Standalone on purpose: started outside Next, it only imports types.

import { spawn, type StdioOptions } from "node:child_process";
import {
  appendFileSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Run, RunStatus } from "../lib/jobs";
import type { RunSpec } from "./jobs";

const dir = process.argv[2];
const spec: RunSpec = JSON.parse(
  readFileSync(path.join(dir, "spec.json"), "utf8"),
);
let run: Run = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8"));

const C = {
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
  off: "\x1b[0m",
};

const logPath = path.join(dir, "output.log");
const log = openSync(logPath, "a");
const say = (text: string) => {
  try {
    appendFileSync(log, text + "\n");
  } catch {}
};

/** The run may have been deleted meanwhile (job deleted); don't recreate it. */
function save(patch: Partial<Run>) {
  run = { ...run, ...patch };
  try {
    const file = path.join(dir, "run.json");
    writeFileSync(`${file}.tmp`, JSON.stringify(run, null, 2) + "\n");
    renameSync(`${file}.tmp`, file);
  } catch {}
}

const home = os.homedir();
const tildify = (p: string) =>
  p.startsWith(home) ? `~${p.slice(home.length)}` : p;
const started = Date.now();

say(`${C.dim}▸ ${spec.title}${C.off}`);
say(
  `${C.dim}  in ${tildify(spec.cwd)} · ${new Date().toLocaleString()} · timeout ${spec.timeoutMin}m${C.off}\n`,
);

const child = spawn(spec.argv[0], spec.argv.slice(1), {
  cwd: spec.cwd,
  env: spec.env as NodeJS.ProcessEnv,
  // Its own group, so stopping kills everything it started.
  detached: true,
  stdio: [
    spec.stdin === undefined ? "ignore" : "pipe",
    spec.kind === "claude" ? "pipe" : log,
    log,
  ] as StdioOptions,
});

/** Set when we kill it, so the exit is recorded for what it was. */
let reason: "timeout" | "cancelled" | null = null;
let killTimer: NodeJS.Timeout | undefined;

function stop(why: "timeout" | "cancelled") {
  if (reason || child.pid === undefined) return;
  reason = why;
  const group = -child.pid;
  try {
    process.kill(group, "SIGTERM");
  } catch {}
  killTimer = setTimeout(() => {
    try {
      process.kill(group, "SIGKILL");
    } catch {}
  }, 10_000);
}

const timeout = setTimeout(() => stop("timeout"), spec.timeoutMin * 60_000);
process.on("SIGTERM", () => stop("cancelled"));
process.on("SIGINT", () => stop("cancelled"));
process.on("SIGHUP", () => {}); // the server going away isn't a reason to stop

if (spec.stdin !== undefined) child.stdin?.end(spec.stdin);

// ── Claude's stream-json → readable lines ─────────────────────────────────

type Block = {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  is_error?: boolean;
};
type Result = {
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  session_id?: string;
  subtype?: string;
};

let result: Result | null = null;
let lastText = "";

const oneLine = (s: string, max = 160) => {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The one argument worth seeing for common tools. */
function toolSummary(name: string, input: Record<string, unknown> = {}) {
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof input[k] === "string") return input[k];
    return null;
  };
  const value =
    pick("command", "file_path", "path", "pattern", "url", "query") ??
    pick("description", "prompt", "skill") ??
    JSON.stringify(input);
  return oneLine(String(value).replace(home, "~"), 120);
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c?.text === "string" ? c.text : ""))
      .join(" ");
  }
  return "";
}

function onEvent(e: Record<string, unknown>) {
  const message = e.message as { content?: Block[] } | undefined;
  switch (e.type) {
    case "system":
      if (e.subtype === "init") {
        save({ claude: { ...run.claude, sessionId: String(e.session_id) } });
        say(`${C.dim}  model ${e.model} · session ${e.session_id}${C.off}\n`);
      }
      return;
    case "assistant":
      for (const block of message?.content ?? []) {
        if (block.type === "text" && block.text?.trim()) {
          lastText = block.text.trim();
          say(`${lastText}\n`);
        } else if (block.type === "tool_use") {
          say(
            `${C.cyan}⏺ ${block.name}${C.off} ${C.dim}${toolSummary(block.name ?? "", block.input)}${C.off}`,
          );
        }
      }
      return;
    case "user":
      for (const block of message?.content ?? []) {
        if (block.type === "tool_result" && block.is_error) {
          say(`${C.red}  ✗ ${oneLine(toolResultText(block.content))}${C.off}`);
        }
      }
      return;
    case "result":
      result = e as Result;
      return;
  }
}

if (spec.kind === "claude" && child.stdout) {
  const raw = path.join(dir, "raw.jsonl");
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      appendFileSync(raw, line + "\n");
    } catch {}
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      return say(line);
    }
    onEvent(event);
  });
}

// ── Finish ────────────────────────────────────────────────────────────────

function finish(status: RunStatus, exitCode: number | null, note?: string) {
  clearTimeout(timeout);
  clearTimeout(killTimer);
  const took = Math.round((Date.now() - started) / 1000);
  const time =
    took < 60
      ? `${took}s`
      : `${Math.floor(took / 60)}m${String(took % 60).padStart(2, "0")}s`;
  const r = result as Result | null;
  const turns = r?.num_turns ? ` · ${r.num_turns} turns` : "";
  const footer: Record<RunStatus, string> = {
    ok: `${C.green}${C.bold}✓ ok${C.off}${C.dim} · ${time}${turns}${C.off}`,
    failed: `${C.red}${C.bold}✗ failed${C.off}${C.dim}${exitCode ? ` (exit ${exitCode})` : ""} · ${time}${turns}${C.off}`,
    timeout: `${C.red}${C.bold}✗ timed out${C.off}${C.dim} after ${spec.timeoutMin}m${C.off}`,
    cancelled: `${C.yellow}${C.bold}■ stopped${C.off}${C.dim} · ${time}${C.off}`,
    running: "",
    lost: "",
    skipped: "",
  };
  if (note) say(`${C.red}${note}${C.off}`);
  say(`\n${footer[status]}`);
  save({
    status,
    exitCode,
    endedAt: new Date().toISOString(),
    ...(note && { note }),
    ...(spec.kind === "claude" && {
      claude: {
        ...run.claude,
        sessionId: r?.session_id ?? run.claude?.sessionId,
        result: r?.result || lastText || undefined,
        turns: r?.num_turns,
      },
    }),
  });
  process.exit(0);
}

child.on("error", (err) =>
  finish("failed", null, `Couldn't start: ${err.message}`),
);

// "close", not "exit": stdout must be fully read (the result event is last).
child.on("close", (code, signal) => {
  if (reason) return finish(reason, code);
  const r = result as Result | null;
  const ok =
    code === 0 && (spec.kind === "shell" || (r !== null && !r.is_error));
  const note = signal
    ? `Killed by ${signal}`
    : spec.kind === "claude" && code === 0 && !r
      ? "Claude exited without a result"
      : r?.is_error && r.subtype && r.subtype !== "success"
        ? `Claude stopped: ${r.subtype}`
        : undefined;
  finish(ok ? "ok" : "failed", code, note);
});
