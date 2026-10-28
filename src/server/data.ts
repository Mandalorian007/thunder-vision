import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import type { Run, RunStatus, StepStatus } from "@/lib/workflows";
import { toAbsolute } from "./repos";
import { tildify } from "./tmux";

const home = os.homedir();

/**
 * Thunder Vision's own state: workflow runs and their worktrees, local
 * workflows, uploads. Outside the app folder, so worktrees full of source
 * never land where tsc, eslint and the dev watcher look.
 */
export const DATA_DIR = path.resolve(
  /*turbopackIgnore: true*/ process.env.TV_DATA_DIR?.replace(
    /^~(?=\/|$)/,
    home,
  ) || path.join(home, ".thunder-vision"),
);

export function writeJson(file: string, data: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

// ── From scheduled jobs (<app>/.thunder) ──────────────────────────────────

type LegacyJob = {
  id: string;
  name: string;
  dir: string;
  schedule: string;
  enabled: boolean;
  timeoutMin: number;
  keepRuns: number;
  scheduledThrough: string;
  task:
    | { kind: "claude"; prompt: string; model: string; effort: string }
    | { kind: "shell"; command: string };
};

type LegacyRun = {
  id: string;
  jobId: string;
  trigger: Run["trigger"];
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  pid?: number;
  exitCode?: number | null;
  note?: string;
  claude?: { sessionId?: string; result?: string };
};

function move(from: string, to: string) {
  mkdirSync(path.dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch {
    // Another volume.
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

function subdirs(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function alive(pid: number | undefined) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A heredoc delimiter that isn't a line of the prompt. */
function delimiter(text: string) {
  const lines = new Set(text.split("\n"));
  let d = "PROMPT";
  for (let n = 2; lines.has(d); n++) d = `PROMPT${n}`;
  return d;
}

function stepFor(task: LegacyJob["task"]) {
  if (task.kind === "shell") return task.command;
  const d = delimiter(task.prompt);
  return (
    `tv-claude --model ${task.model} --effort ${task.effort} <<'${d}'\n` +
    `${task.prompt.replace(/\n+$/, "")}\n${d}\n`
  );
}

/** One-step workflow runs, so old history still reads the same. */
function convertRun(old: LegacyRun, workflowId: string, logBytes: number): Run {
  const step: StepStatus = old.status === "skipped" ? "pending" : old.status;
  return {
    id: old.id,
    workflowId,
    trigger: old.trigger,
    status: old.status,
    startedAt: old.startedAt,
    endedAt: old.endedAt,
    note: old.note,
    inputs: {},
    outputs: {},
    result: old.claude?.result,
    steps:
      old.status === "skipped"
        ? []
        : [
            {
              id: "run",
              status: step,
              startedAt: old.startedAt,
              endedAt: old.endedAt,
              exitCode: old.exitCode,
              logStart: 0,
              logEnd: logBytes,
              claude: old.claude && {
                sessionId: old.claude.sessionId,
                result: old.claude.result,
              },
            },
          ],
  };
}

/**
 * Scheduled jobs and uploads used to live in <app>/.thunder. Moves them to
 * DATA_DIR once, turning each job into a local workflow file. Run by the
 * server at boot, before the scheduler starts; does nothing after that.
 */
export function migrateLegacyData(state: {
  set(id: string, s: { enabled: boolean; scheduledThrough: string }): void;
}) {
  if (process.env.TV_DATA_DIR) return;
  const legacy = path.join(/*turbopackIgnore: true*/ process.cwd(), ".thunder");
  if (!statSync(legacy, { throwIfNoEntry: false })?.isDirectory()) return;
  const done: string[] = [];

  const uploads = path.join(legacy, "uploads");
  if (existsSync(uploads) && !existsSync(path.join(DATA_DIR, "uploads"))) {
    move(uploads, path.join(DATA_DIR, "uploads"));
    done.push("uploads");
  }

  const jobsFile = path.join(legacy, "jobs.json");
  const jobs = readJson<LegacyJob[]>(jobsFile);
  if (Array.isArray(jobs)) {
    for (const job of jobs) {
      const id = `local--${job.id}`;
      const file = path.join(DATA_DIR, "workflows", `${job.id}.yml`);
      if (!existsSync(file)) {
        const doc = {
          name: job.name,
          dir: tildify(toAbsolute(job.dir)),
          schedule: job.schedule,
          worktree: false,
          timeout: job.timeoutMin,
          keep: job.keepRuns,
          steps: [{ id: "run", run: stepFor(job.task) }],
        };
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(
          file,
          `# Converted from the scheduled job "${job.name}".\n` +
            stringify(doc, { lineWidth: 0 }),
        );
        state.set(id, {
          enabled: job.enabled,
          scheduledThrough: job.scheduledThrough,
        });
      }

      const oldRuns = path.join(legacy, "runs", job.id);
      for (const runId of subdirs(oldRuns)) {
        const from = path.join(oldRuns, runId);
        const old = readJson<LegacyRun>(path.join(from, "run.json"));
        // Still writing to the old folder; it settles there.
        if (!old || (old.status === "running" && alive(old.pid))) continue;
        const to = path.join(DATA_DIR, "runs", id, runId);
        if (existsSync(to)) continue;
        const log = statSync(path.join(from, "output.log"), {
          throwIfNoEntry: false,
        });
        const run = convertRun(
          old.status === "running"
            ? { ...old, status: "lost", note: "Lost while migrating" }
            : old,
          id,
          log?.size ?? 0,
        );
        move(from, to);
        rmSync(path.join(to, "spec.json"), { force: true });
        writeJson(path.join(to, "run.json"), run);
      }
    }
    move(jobsFile, path.join(DATA_DIR, "jobs.json.migrated"));
    done.push(`${jobs.length} job(s)`);
  }

  // Leave the folder only if something is still in it.
  for (const dir of [
    ...subdirs(path.join(legacy, "runs")).map((d) =>
      path.join(legacy, "runs", d),
    ),
    path.join(legacy, "runs"),
    legacy,
  ]) {
    try {
      rmdirSync(dir);
    } catch {}
  }
  if (done.length) {
    console.log(`[workflows] moved ${done.join(", ")} to ${tildify(DATA_DIR)}`);
  }
}
