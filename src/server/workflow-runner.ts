// Runs one workflow, detached from the server: `node --import tsx
// workflow-runner.ts <run folder>`. Reads spec.json; adds the worktree, runs
// the steps in order, then removes or keeps the worktree. Writes output.log
// (what the live log tails; Claude's stream is turned into readable lines,
// and each step's byte range is recorded so it can be shown on its own) and
// the state as it goes into run.json.
//
// Standalone on purpose: started outside Next, it imports no app modules
// besides the plain helpers in lib/workflows.

import { type ChildProcess, spawn } from "node:child_process";
import {
  appendFileSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  duration,
  envName,
  NO_CHANGES_EXIT,
  parseOutputs,
  type Run,
  type RunStatus,
  type StepRun,
  type StepStatus,
} from "../lib/workflows";
import type { RunSpec } from "./workflows";

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

const log = openSync(path.join(dir, "output.log"), "a");
const write = (text: string) => {
  try {
    appendFileSync(log, text);
  } catch {}
};
const say = (text: string) => write(text + "\n");
const logSize = () => fstatSync(log).size;

/** The run may have been deleted meanwhile; don't recreate it. */
function save(patch: Partial<Run>) {
  run = { ...run, ...patch };
  try {
    const file = path.join(dir, "run.json");
    writeFileSync(`${file}.tmp`, JSON.stringify(run, null, 2) + "\n");
    renameSync(`${file}.tmp`, file);
  } catch {}
}

function saveStep(i: number, patch: Partial<StepRun>) {
  save({
    steps: run.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)),
  });
}

const home = os.homedir();
const tildify = (p: string) =>
  p.startsWith(home) ? `~${p.slice(home.length)}` : p;
const started = Date.now();

// ── Stopping ──────────────────────────────────────────────────────────────

/** Whatever is running now: a git command during setup, or a step. */
let current: ChildProcess | null = null;
let stepChild: ChildProcess | null = null;
/** Set when we kill it, so the exit is recorded for what it was. */
let reason: "timeout" | "cancelled" | null = null;
let killTimer: NodeJS.Timeout | undefined;

function kill(child: ChildProcess) {
  if (child.pid === undefined || child.exitCode !== null) return;
  // Steps get their own group, so stopping kills everything they started.
  const target = child === stepChild ? -child.pid : child.pid;
  try {
    process.kill(target, "SIGTERM");
  } catch {}
  killTimer = setTimeout(() => {
    try {
      process.kill(target, "SIGKILL");
    } catch {}
  }, 10_000);
}

function stop(why: "timeout" | "cancelled") {
  if (reason) return;
  reason = why;
  if (current) kill(current);
}

const timeout = setTimeout(() => stop("timeout"), spec.timeoutMin * 60_000);
process.on("SIGTERM", () => stop("cancelled"));
process.on("SIGINT", () => stop("cancelled"));
process.on("SIGHUP", () => {}); // the server going away isn't a reason to stop

// ── Git (the worktree) ────────────────────────────────────────────────────

type Result = { code: number | null; out: string; err: string };

const gitEnv: Record<string, string> = {
  ...spec.env,
  GIT_TERMINAL_PROMPT: "0",
};

function git(args: string[], cwd = spec.dir): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      // Next's types make NODE_ENV required; the runner has its own env.
      env: gitEnv as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    current = child;
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ code: null, out, err: e.message }));
    child.on("close", (code) => {
      if (current === child) current = null;
      resolve({ code, out: out.trim(), err: err.trim() });
    });
  });
}

class SetupFailed extends Error {}

const firstLine = (s: string) => s.split("\n").find(Boolean) ?? s;

async function addWorktree() {
  const wt = spec.worktree!;
  let base = wt.base ?? "HEAD";
  if ((await git(["remote", "get-url", "origin"])).code === 0) {
    say(`${C.dim}  fetching origin…${C.off}`);
    const fetched = await git(["fetch", "--quiet", "origin"]);
    if (reason) return null;
    if (fetched.code !== 0) {
      say(
        `${C.yellow}  couldn't fetch origin (${firstLine(fetched.err)}); branching from what's here${C.off}`,
      );
    }
    if (wt.base) {
      const remote = `origin/${wt.base}`;
      const has = await git([
        "rev-parse",
        "--verify",
        "--quiet",
        `${remote}^{commit}`,
      ]);
      if (has.code === 0) base = remote;
    } else {
      let head = await git([
        "symbolic-ref",
        "--short",
        "refs/remotes/origin/HEAD",
      ]);
      if (head.code !== 0) {
        await git(["remote", "set-head", "origin", "--auto"]);
        head = await git([
          "symbolic-ref",
          "--short",
          "refs/remotes/origin/HEAD",
        ]);
      }
      if (head.code === 0 && head.out) base = head.out;
    }
  }
  if (reason) return null;
  const ok = await git([
    "rev-parse",
    "--verify",
    "--quiet",
    `${base}^{commit}`,
  ]);
  if (ok.code !== 0) throw new SetupFailed(`There's no ${base} to branch from`);

  mkdirSync(path.dirname(wt.path), { recursive: true });
  save({
    worktree: {
      repo: spec.dir,
      path: wt.path,
      branch: wt.branch,
      base,
      state: "creating",
    },
  });
  const added = await git([
    "worktree",
    "add",
    "--quiet",
    "--no-track",
    "-b",
    wt.branch,
    wt.path,
    base,
  ]);
  if (added.code !== 0) {
    throw new SetupFailed(`Couldn't add the worktree: ${firstLine(added.err)}`);
  }
  save({ worktree: { ...run.worktree!, state: "active" } });
  say(
    `${C.dim}  worktree ${tildify(wt.path)} · ${wt.branch} from ${base}${C.off}`,
  );
  return wt.path;
}

/**
 * After ok / no changes the worktree goes. Its branch goes too, unless it
 * has commits that aren't on the remote (pushed work is safe; anything
 * else is yours to look at). After a failure both stay.
 */
async function cleanUp(status: RunStatus) {
  const wt = run.worktree;
  if (!wt || wt.state === "removed") return;
  if (status !== "ok" && status !== "nochange") {
    save({ worktree: { ...wt, state: "kept" } });
    say(`${C.dim}  kept the worktree: ${tildify(wt.path)}${C.off}`);
    return;
  }
  // Not cancellable: it's quick, and half a cleanup is worse.
  const removed = await git(["worktree", "remove", "--force", wt.path]);
  if (removed.code !== 0) {
    save({ worktree: { ...wt, state: "kept" } });
    say(
      `${C.yellow}  couldn't remove the worktree: ${firstLine(removed.err)}${C.off}`,
    );
    return;
  }
  const ahead = await git([
    "rev-list",
    "--count",
    `${wt.base ?? "HEAD"}..${wt.branch}`,
  ]);
  const remote = await git(["branch", "-r", "--contains", wt.branch]);
  const safe = ahead.out === "0" || (remote.code === 0 && remote.out !== "");
  if (safe) await git(["branch", "-D", wt.branch]);
  else
    say(`${C.dim}  kept branch ${wt.branch}: it has unpushed commits${C.off}`);
  save({ worktree: { ...wt, state: "removed", branchKept: !safe } });
}

// ── Claude's stream-json → readable lines ─────────────────────────────────

type Block = {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  is_error?: boolean;
};

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

/** What one step's tv-claude calls said; the last call wins. */
type Claude = { sessionId?: string; result?: string; lastText?: string };

function onEvent(e: Record<string, unknown>, claude: Claude, i: number) {
  const message = e.message as { content?: Block[] } | undefined;
  switch (e.type) {
    case "system":
      if (e.subtype === "init") {
        claude.sessionId = String(e.session_id);
        claude.result = undefined;
        claude.lastText = undefined;
        saveStep(i, { claude: { sessionId: claude.sessionId } });
        say(
          `${C.dim}  claude · ${e.model} · session ${e.session_id}${C.off}\n`,
        );
      }
      return;
    case "assistant":
      for (const block of message?.content ?? []) {
        if (block.type === "text" && block.text?.trim()) {
          claude.lastText = block.text.trim();
          say(`${claude.lastText}\n`);
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
    case "result": {
      const r = e as {
        result?: string;
        is_error?: boolean;
        subtype?: string;
        num_turns?: number;
      };
      claude.result = r.result || claude.lastText;
      const turns = r.num_turns ? ` · ${r.num_turns} turns` : "";
      say(
        r.is_error
          ? `${C.red}  claude stopped: ${r.subtype ?? "error"}${turns}${C.off}`
          : `${C.dim}  claude done${turns}${C.off}`,
      );
      return;
    }
  }
}

/**
 * A step's stdout: stream-json lines (from tv-claude) become readable lines,
 * anything else goes through as-is. A partial line that isn't JSON goes out
 * straight away, so a prompt or a progress bar shows while it's written.
 */
function stdoutHandler(i: number, claude: Claude, rawFile: string) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let passthrough = false;
  const line = (text: string) => {
    if (text.startsWith("{")) {
      try {
        const event = JSON.parse(text);
        if (event && typeof event.type === "string") {
          appendFileSync(rawFile, text + "\n");
          onEvent(event, claude, i);
          return;
        }
      } catch {}
    }
    say(text);
  };
  const feed = (s: string) => {
    while (s) {
      if (passthrough) {
        const nl = s.indexOf("\n");
        if (nl < 0) return write(s);
        write(s.slice(0, nl + 1));
        s = s.slice(nl + 1);
        passthrough = false;
        continue;
      }
      pending += s;
      s = "";
      let nl: number;
      while ((nl = pending.indexOf("\n")) >= 0) {
        line(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
      }
      if (pending && !pending.startsWith("{")) {
        write(pending);
        pending = "";
        passthrough = true;
      }
    }
  };
  return {
    data: (chunk: Buffer) => feed(decoder.write(chunk)),
    end: () => {
      const rest = pending + decoder.end();
      if (rest) line(rest);
    },
  };
}

// ── Steps ─────────────────────────────────────────────────────────────────

/** Steps are bash -eo pipefail scripts, after your login shell sets PATH. */
const LOGIN_SHELL = /\/(zsh|bash|sh|ksh)$/.test(process.env.SHELL ?? "")
  ? process.env.SHELL!
  : "/bin/zsh";

const STEP_MARK: Record<StepStatus, string> = {
  ok: `${C.green}${C.bold}✓`,
  nochange: `${C.dim}${C.bold}–`,
  failed: `${C.red}${C.bold}✗`,
  timeout: `${C.red}${C.bold}✗`,
  cancelled: `${C.yellow}${C.bold}■`,
  lost: `${C.red}${C.bold}✗`,
  running: "",
  pending: "",
};

async function runStep(i: number, cwd: string): Promise<StepStatus> {
  const step = spec.steps[i];
  const n = spec.steps.length;
  const stepsDir = path.join(dir, "steps");
  mkdirSync(stepsDir, { recursive: true });
  mkdirSync(path.join(dir, "artifacts"), { recursive: true });
  const stem = path.join(stepsDir, `${i + 1}-${step.id}`);
  const outFile = `${stem}.out`;
  writeFileSync(`${stem}.sh`, step.run);
  writeFileSync(outFile, "");

  const logStart = logSize();
  const t0 = Date.now();
  say(`\n${C.bold}${C.cyan}━━ ${i + 1}/${n} ${step.id}${C.off}`);
  saveStep(i, {
    status: "running",
    startedAt: new Date().toISOString(),
    logStart,
  });

  const env: Record<string, string> = {
    ...spec.env,
    TV_STEP: step.id,
    TV_OUTPUT: outFile,
    TV_SUMMARY: path.join(dir, "summary.md"),
    TV_ARTIFACTS: path.join(dir, "artifacts"),
  };
  for (const [k, v] of Object.entries(run.outputs))
    env[envName("TV_OUT_", k)] = v;
  if (run.worktree) {
    env.TV_BRANCH = run.worktree.branch;
    env.TV_BASE = run.worktree.base ?? "";
    env.TV_WORKTREE = run.worktree.path;
  }

  const claude: Claude = {};
  const child = spawn(
    LOGIN_SHELL,
    ["-lc", 'exec /bin/bash -eo pipefail "$0"', `${stem}.sh`],
    {
      cwd,
      env: env as NodeJS.ProcessEnv,
      detached: true,
      stdio: ["ignore", "pipe", log],
    },
  );
  current = stepChild = child;
  const out = stdoutHandler(i, claude, `${stem}.jsonl`);
  child.stdout?.on("data", out.data);

  // "close", not "exit": stdout must be fully read (the result event is last).
  const [code, signal] = await new Promise<[number | null, string | null]>(
    (resolve) => {
      child.on("error", (err) => {
        say(`${C.red}Couldn't start: ${err.message}${C.off}`);
        resolve([null, null]);
      });
      child.on("close", (c, s) => resolve([c, s]));
    },
  );
  out.end();
  current = stepChild = null;
  clearTimeout(killTimer);

  let outputs: Record<string, string> = {};
  try {
    outputs = parseOutputs(readFileSync(outFile, "utf8"));
  } catch {}

  const status: StepStatus = reason
    ? reason
    : code === 0
      ? "ok"
      : code === NO_CHANGES_EXIT
        ? "nochange"
        : "failed";
  const took = duration(Date.now() - t0);
  const detail =
    status === "failed"
      ? signal
        ? ` (killed by ${signal})`
        : code !== null
          ? ` (exit ${code})`
          : ""
      : status === "nochange"
        ? " no changes"
        : status === "timeout"
          ? ` after ${spec.timeoutMin}m`
          : "";
  say(
    `${STEP_MARK[status]} ${step.id}${C.off}${C.dim}${detail} · ${took}${C.off}`,
  );

  save({
    outputs: { ...run.outputs, ...outputs },
    ...(claude.result || claude.lastText
      ? { result: claude.result ?? claude.lastText }
      : {}),
  });
  saveStep(i, {
    status,
    endedAt: new Date().toISOString(),
    exitCode: code,
    logEnd: logSize(),
    ...(claude.sessionId && {
      claude: {
        sessionId: claude.sessionId,
        result: claude.result ?? claude.lastText,
      },
    }),
  });
  return status;
}

// ── The run ───────────────────────────────────────────────────────────────

const FOOTER: Record<RunStatus, string> = {
  ok: `${C.green}${C.bold}✓ ok${C.off}`,
  nochange: `${C.bold}– no changes${C.off}`,
  failed: `${C.red}${C.bold}✗ failed${C.off}`,
  timeout: `${C.red}${C.bold}✗ timed out${C.off}`,
  cancelled: `${C.yellow}${C.bold}■ stopped${C.off}`,
  running: "",
  lost: "",
  skipped: "",
};

async function main() {
  say(`${C.bold}▸ ${spec.name}${C.off}`);
  say(
    `${C.dim}  in ${tildify(spec.dir)} · ${new Date().toLocaleString()} · timeout ${spec.timeoutMin}m${C.off}`,
  );
  const given = Object.entries(run.inputs);
  if (given.length) {
    say(
      `${C.dim}  ${given.map(([k, v]) => `${k}=${oneLine(v, 60)}`).join(" · ")}${C.off}`,
    );
  }

  let status: RunStatus = "ok";
  let note: string | undefined;
  let cwd = spec.dir;
  if (spec.worktree) {
    try {
      const wt = await addWorktree();
      if (wt) cwd = wt;
    } catch (err) {
      status = "failed";
      note = err instanceof Error ? err.message : String(err);
      say(`${C.red}${note}${C.off}`);
    }
  }

  for (let i = 0; i < spec.steps.length && status === "ok"; i++) {
    if (reason) break;
    const s = await runStep(i, cwd);
    if (s !== "ok") status = s === "pending" || s === "running" ? "failed" : s;
  }
  if (reason) status = reason;
  if (status === "timeout") note = `Timed out after ${spec.timeoutMin}m`;
  if (status === "cancelled") note ??= "Stopped";

  clearTimeout(timeout);
  await cleanUp(status);
  say(
    `\n${FOOTER[status]}${C.dim} · ${duration(Date.now() - started)}${C.off}`,
  );
  save({
    status,
    endedAt: new Date().toISOString(),
    ...(note && { note }),
  });
  process.exit(0);
}

main().catch((err) => {
  say(`${C.red}${err instanceof Error ? err.stack : String(err)}${C.off}`);
  save({
    status: "failed",
    endedAt: new Date().toISOString(),
    note: `The runner crashed: ${err instanceof Error ? err.message : err}`,
  });
  process.exit(1);
});
