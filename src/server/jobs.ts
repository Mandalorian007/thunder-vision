import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Cron } from "croner";
import {
  type Job,
  type JobSummary,
  RECENT_RUNS,
  type Run,
  RUN_ID,
  runIdFor,
} from "@/lib/jobs";
import { toAbsolute } from "./repos";
import { cleanEnv } from "./tmux";

// Everything lives in files, on purpose: the scheduler (loaded by server.ts)
// and the API routes (bundled by Next) are separate copies of this module, and
// each run is its own detached process that outlives server restarts. File
// writes are synchronous, so a read-modify-write never interleaves with
// another one in this process.

const home = os.homedir();

/** Gitignored, next to the app by default: easy to poke at when debugging. */
export const DATA_DIR = path.resolve(
  /*turbopackIgnore: true*/ process.env.TV_DATA_DIR?.replace(
    /^~(?=\/|$)/,
    home,
  ) || path.join(process.cwd(), ".thunder"),
);
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");
const RUNS_DIR = path.join(DATA_DIR, "runs");
/** The detached process that runs one job and records how it went. */
const RUNNER = path.join(
  /*turbopackIgnore: true*/ process.cwd(),
  "src/server/job-runner.ts",
);

/** What the runner needs, written next to run.json before it starts. */
export type RunSpec = {
  kind: "claude" | "shell";
  cwd: string;
  argv: string[];
  /** Sent on stdin, then closed (Claude's prompt). */
  stdin?: string;
  env: Record<string, string>;
  timeoutMin: number;
  /** For the log header. */
  title: string;
};

function writeJson(file: string, data: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

// ── Jobs ──────────────────────────────────────────────────────────────────

export function readJobs(): Job[] {
  const jobs = readJson<Job[]>(JOBS_FILE);
  return Array.isArray(jobs) ? jobs : [];
}

/** Read, change, write; nothing can land in between (all synchronous). */
export function updateJobs<T>(fn: (jobs: Job[]) => T): T {
  const jobs = readJobs();
  const result = fn(jobs);
  writeJson(JOBS_FILE, jobs);
  return result;
}

export function getJob(id: string) {
  return readJobs().find((j) => j.id === id) ?? null;
}

/** Throws on a bad pattern; the message says what's wrong. */
export function checkCron(schedule: string) {
  new Cron(schedule);
}

export function nextRunAt(job: Job, after = new Date()) {
  if (!job.enabled) return null;
  try {
    return new Cron(job.schedule).nextRun(after)?.getTime() ?? null;
  } catch {
    return null;
  }
}

/** The first time due after `scheduledThrough`, if that's already passed. */
export function dueAt(job: Job, now = new Date()) {
  if (!job.enabled) return null;
  try {
    const next = new Cron(job.schedule).nextRun(new Date(job.scheduledThrough));
    return next && next <= now ? next : null;
  } catch {
    return null;
  }
}

export function summaries(): JobSummary[] {
  return readJobs().map((job) => ({
    ...job,
    nextRunAt: nextRunAt(job),
    recent: listRuns(job.id, RECENT_RUNS)
      .reverse()
      .map(({ id, status, startedAt, endedAt, trigger }) => ({
        id,
        status,
        startedAt,
        endedAt,
        trigger,
      })),
  }));
}

// ── Runs ──────────────────────────────────────────────────────────────────

const runsDir = (jobId: string) => path.join(RUNS_DIR, jobId);
export const runDir = (jobId: string, runId: string) =>
  path.join(RUNS_DIR, jobId, runId);
const runFile = (jobId: string, runId: string) =>
  path.join(runDir(jobId, runId), "run.json");
export const logFile = (jobId: string, runId: string) =>
  path.join(runDir(jobId, runId), "output.log");

function alive(pid: number | undefined) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function runIds(jobId: string) {
  try {
    return readdirSync(runsDir(jobId))
      .filter((name) => RUN_ID.test(name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** A "running" run whose runner died (crash, reboot) can't finish; say so. */
function settle(run: Run): Run {
  if (run.status !== "running" || alive(run.pid)) return run;
  // It may have finished between the two reads.
  const fresh = readJson<Run>(runFile(run.jobId, run.id));
  if (fresh && fresh.status !== "running") return fresh;
  const lost: Run = {
    ...run,
    status: "lost",
    endedAt: new Date().toISOString(),
    note: "The runner stopped before the job finished (crash or reboot?)",
  };
  writeJson(runFile(run.jobId, run.id), lost);
  return lost;
}

export function getRun(jobId: string, runId: string) {
  const run = readJson<Run>(runFile(jobId, runId));
  return run && settle(run);
}

/** Newest first. */
export function listRuns(jobId: string, limit = Infinity): Run[] {
  const runs: Run[] = [];
  for (const id of runIds(jobId)) {
    if (runs.length >= limit) break;
    const run = getRun(jobId, id);
    if (run) runs.push(run);
  }
  return runs;
}

export function activeRun(jobId: string) {
  return listRuns(jobId, 5).find((r) => r.status === "running") ?? null;
}

function newRunId(jobId: string, now: Date) {
  const base = runIdFor(now);
  let id = base;
  for (let n = 2; existsSync(runDir(jobId, id)); n++) id = `${base}-${n}`;
  return id;
}

/** ~/.local/bin isn't on a login shell's PATH (it's added in .zshrc). */
function claudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const local = path.join(home, ".local/bin/claude");
  return existsSync(local) ? local : "claude";
}

function specFor(job: Job, cwd: string): RunSpec {
  const shell = process.env.SHELL || "/bin/zsh";
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(cleanEnv())) {
    if (v !== undefined) env[k] = v;
  }
  const claude = claudeBin();
  if (claude.includes("/")) {
    env.PATH = `${path.dirname(claude)}:${env.PATH ?? "/usr/bin:/bin"}`;
  }
  // A login shell, so jobs see your PATH (Homebrew etc.) even under launchd.
  if (job.task.kind === "shell") {
    return {
      kind: "shell",
      cwd,
      argv: [shell, "-lc", job.task.command],
      env,
      timeoutMin: job.timeoutMin,
      title: `$ ${job.task.command}`,
    };
  }
  const { prompt, model, effort } = job.task;
  return {
    kind: "claude",
    cwd,
    argv: [
      shell,
      "-lc",
      'exec "$0" "$@"',
      claude,
      "-p",
      "--permission-mode",
      "auto",
      "--model",
      model,
      "--effort",
      effort,
      "--output-format",
      "stream-json",
      "--verbose",
    ],
    stdin: prompt,
    env,
    timeoutMin: job.timeoutMin,
    title: `claude -p ${JSON.stringify(prompt)} · ${model} · ${effort}`,
  };
}

/**
 * Starts a run in the background. If the last one is still going, records a
 * skipped run instead; a missing folder records a failed one.
 */
export function startRun(job: Job, trigger: Run["trigger"]): Run {
  const now = new Date();
  const id = newRunId(job.id, now);
  const base: Run = {
    id,
    jobId: job.id,
    trigger,
    status: "running",
    startedAt: now.toISOString(),
  };
  const done = (status: Run["status"], note: string) => {
    const run: Run = { ...base, status, note, endedAt: base.startedAt };
    writeJson(runFile(job.id, id), run);
    return run;
  };

  const busy = activeRun(job.id);
  if (busy) return done("skipped", `Run ${busy.id} was still going`);

  const cwd = toAbsolute(job.dir);
  if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    return done("failed", `Folder ${job.dir} doesn't exist`);
  }

  const dir = runDir(job.id, id);
  writeJson(path.join(dir, "spec.json"), specFor(job, cwd));
  writeJson(runFile(job.id, id), base);
  // Its own session and process group: survives server restarts (and
  // launchd's cleanup of the server's group), and can be stopped as a whole.
  const child = spawn(process.execPath, ["--import", "tsx", RUNNER, dir], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: cleanEnv(),
  });
  child.on("error", (err) => {
    writeJson(runFile(job.id, id), {
      ...base,
      status: "failed",
      endedAt: new Date().toISOString(),
      note: `Couldn't start the runner: ${err.message}`,
    } satisfies Run);
  });
  child.unref();
  // Synchronously, before the runner has booted and read it back.
  const run: Run = { ...base, pid: child.pid };
  writeJson(runFile(job.id, id), run);
  prune(job);
  return run;
}

/** Asks the runner to stop; it kills the job and records "stopped". */
export function stopRun(jobId: string, runId: string) {
  const run = getRun(jobId, runId);
  if (run?.status !== "running" || !run.pid) return false;
  try {
    process.kill(run.pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

/** Keeps the newest `keepRuns`; a running one is never deleted. */
function prune(job: Job) {
  for (const id of runIds(job.id).slice(job.keepRuns)) {
    if (getRun(job.id, id)?.status !== "running") deleteRun(job.id, id);
  }
}

export function deleteRun(jobId: string, runId: string) {
  if (!RUN_ID.test(runId)) return false;
  const run = getRun(jobId, runId);
  if (!run || run.status === "running") return false;
  rmSync(runDir(jobId, runId), { recursive: true, force: true });
  return true;
}

/** Every finished run; a running one stays. */
export function clearRuns(jobId: string) {
  for (const id of runIds(jobId)) deleteRun(jobId, id);
}

/** Stops a running run first. `history: false` keeps the runs on disk. */
export function deleteJob(id: string, history: boolean) {
  const run = activeRun(id);
  if (run) stopRun(id, run.id);
  updateJobs((jobs) => {
    const i = jobs.findIndex((j) => j.id === id);
    if (i >= 0) jobs.splice(i, 1);
  });
  if (history) rmSync(runsDir(id), { recursive: true, force: true });
}
