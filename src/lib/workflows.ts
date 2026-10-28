// Workflows: shared by the server (store, scheduler, runner) and the UI.
// No Node imports here; the browser bundle uses it too.

export const DEFAULT_TIMEOUT_MIN = 60;
export const MAX_TIMEOUT_MIN = 24 * 60;
export const DEFAULT_KEEP_RUNS = 50;
export const MAX_KEEP_RUNS = 500;
/** A step exits with this to stop the run as "no changes" (GitHub's old neutral). */
export const NO_CHANGES_EXIT = 78;

/** Where workflow files live inside a repo (committed with it). */
export const REPO_WORKFLOWS = ".thunder/workflows";

export type Step = {
  /** Shown in the timeline and the log; "step-2" when the file gives none. */
  id: string;
  /** A bash -eo pipefail script (PATH from your login shell), in the worktree or the folder. */
  run: string;
};

export type Input = { name: string; description?: string; default: string };

export type Workflow = {
  /** "<repo>--<file>" or "local--<file>"; names its runs folder. */
  id: string;
  name: string;
  /** The workflow file, "~/…". */
  file: string;
  /** A repo under TV_ROOT ("my-app", "org/app"), or null for a local file. */
  repo: string | null;
  /** The folder steps run in (or branch from), "~/…". */
  dir: string;
  /** Five-field cron, or null: manual only. */
  schedule: string | null;
  inputs: Input[];
  /** A fresh worktree per run, branched from `base` (default: origin's HEAD). */
  worktree: { base: string | null } | null;
  timeoutMin: number;
  keepRuns: number;
  steps: Step[];
  /** The file doesn't parse; it can't run until fixed. */
  error?: string;
};

export type RunStatus =
  | "running"
  | "ok"
  | "nochange"
  | "failed"
  | "timeout"
  | "cancelled"
  | "lost"
  | "skipped";

/** A step that never started is "pending" (shown as "not run" once done). */
export type StepStatus = Exclude<RunStatus, "skipped"> | "pending";

export type StepRun = {
  id: string;
  status: StepStatus;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number | null;
  /** Byte range of output.log, for the step's own log view. */
  logStart?: number;
  logEnd?: number;
  /** The last `tv-claude` (stream-json) call in this step. */
  claude?: { sessionId?: string; result?: string };
};

export type RunWorktree = {
  /** The main checkout it was added to. */
  repo: string;
  path: string;
  branch: string;
  /** What it branched from, e.g. "origin/main". */
  base?: string;
  /**
   * active while running; removed after ok / no changes; kept after a
   * failure (for "continue in session") until discarded.
   */
  state: "creating" | "active" | "kept" | "removed";
  /** Removed, but the branch has unpushed commits so it stayed. */
  branchKept?: boolean;
};

export type Run = {
  /** Start time, sortable: "20261028-060000". */
  id: string;
  workflowId: string;
  trigger: "schedule" | "manual" | "catch-up";
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  /** The runner process; a dead pid on a "running" run means "lost". */
  pid?: number;
  /** Why it was skipped, lost, stopped early or couldn't start. */
  note?: string;
  inputs: Record<string, string>;
  steps: StepRun[];
  /** Everything the steps wrote to $TV_OUTPUT, later steps winning. */
  outputs: Record<string, string>;
  /** The last Claude final message: the summary when $TV_SUMMARY is empty. */
  result?: string;
  worktree?: RunWorktree;
};

export type RecentRun = Pick<
  Run,
  "id" | "status" | "startedAt" | "endedAt" | "trigger"
>;

/** What the sidebar and workflow header need, polled every few seconds. */
export type WorkflowSummary = Workflow & {
  /** Paused stops the schedule only; Run still works. */
  enabled: boolean;
  /** Epoch ms of the next scheduled run; null when paused or manual. */
  nextRunAt: number | null;
  /** Newest last, at most RECENT_RUNS. */
  recent: RecentRun[];
  /** The newest running run's current step. */
  progress?: { run: string; step: number; of: number; id: string };
  /** The newest `pr` output among the recent runs. */
  lastPr?: string;
};

/** What a run's page loads besides run.json. */
export type RunFiles = {
  summary: string | null;
  artifacts: { path: string; size: number }[];
};

export const RECENT_RUNS = 20;

/** Workflow ids, run ids: safe as folder names and in URLs. */
export const ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
export const RUN_ID = /^\d{8}-\d{6}(-\d+)?$/;
/** Output keys and input names; they become TV_OUT_<KEY> / TV_INPUT_<NAME>. */
export const KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

export function slugify(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "workflow"
  );
}

/** "task" → "TV_INPUT_TASK", "dry-run" → "TV_OUT_DRY_RUN". */
export const envName = (prefix: string, key: string) =>
  `${prefix}${key.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`;

export const isDone = (s: RunStatus) => s !== "running";
export const isGreen = (s: RunStatus | StepStatus) => s === "ok";
export const isRed = (s: RunStatus | StepStatus) =>
  s === "failed" || s === "timeout" || s === "lost";

export const STATUS_LABEL: Record<RunStatus | StepStatus, string> = {
  running: "running",
  ok: "ok",
  nochange: "no changes",
  failed: "failed",
  timeout: "timed out",
  cancelled: "stopped",
  lost: "lost",
  skipped: "skipped",
  pending: "not run",
};

/** "https://github.com/a/b/pull/142" → "PR #142"; anything else as-is. */
export function prLabel(url: string) {
  const n = /\/pull\/(\d+)/.exec(url)?.[1];
  return n ? `PR #${n}` : "PR";
}

export const isUrl = (s: string) => /^https?:\/\/\S+$/.test(s.trim());

// ── Schedules ─────────────────────────────────────────────────────────────
// Workflows store plain cron; these read it back as words.

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
/** "Every N minutes": steps that divide the hour evenly. */
const MINUTE_STEPS = [5, 10, 15, 20, 30];

const pad = (n: number) => String(n).padStart(2, "0");

/** "*", "1-5", "1,3,5", "0-2,6" (7 is Sunday too) → days, or null. */
function parseDow(field: string) {
  if (field === "*") return EVERY_DAY;
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const r = /^([0-7])(?:-([0-7]))?$/.exec(part);
    if (!r) return null;
    const a = Number(r[1]);
    const b = r[2] === undefined ? a : Number(r[2]);
    if (b < a) return null;
    for (let i = a; i <= b; i++) days.add(i % 7);
  }
  return [...days].sort((x, y) => x - y);
}

const NUM = /^\d{1,2}$/;

type Preset =
  | { kind: "minutes"; every: number; days: number[] }
  | { kind: "hourly"; minute: number; days: number[] }
  | { kind: "time"; h: number; m: number; days: number[] }
  | { kind: "cron"; cron: string };

function cronToPreset(cron: string): Preset {
  const f = cron.trim().split(/\s+/);
  const days = f.length === 5 ? parseDow(f[4]) : null;
  if (days && f[2] === "*" && f[3] === "*") {
    const [min, hour] = f;
    const step = /^\*\/(\d{1,2})$/.exec(min);
    if (step && hour === "*" && MINUTE_STEPS.includes(Number(step[1]))) {
      return { kind: "minutes", every: Number(step[1]), days };
    }
    const m = Number(min);
    if (NUM.test(min) && m < 60) {
      if (hour === "*") return { kind: "hourly", minute: m, days };
      if (NUM.test(hour) && Number(hour) < 24) {
        return { kind: "time", h: Number(hour), m, days };
      }
    }
  }
  return { kind: "cron", cron };
}

/** "6:00 AM" / "18:30", in the viewer's locale. */
function clock(h: number, m: number) {
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "daily", "weekdays", "weekends", "Mondays", "Mon, Wed, Fri". */
function daysLabel(days: number[]) {
  const key = days.join(",");
  if (days.length === 7) return "daily";
  if (key === "1,2,3,4,5") return "weekdays";
  if (key === "0,6") return "weekends";
  if (days.length === 1) return `${DAYS[days[0]]}s`;
  return days.map((d) => DAYS[d].slice(0, 3)).join(", ");
}

export function describeSchedule(cron: string | null) {
  if (!cron) return "manual";
  const p = cronToPreset(cron);
  if (p.kind === "cron") return p.cron;
  const on = p.days.length === 7 ? "" : `, ${daysLabel(p.days)}`;
  switch (p.kind) {
    case "minutes":
      return `every ${p.every} min${on}`;
    case "hourly":
      return (
        (p.minute === 0 ? "every hour" : `hourly at :${pad(p.minute)}`) + on
      );
    case "time":
      return `${daysLabel(p.days)} ${clock(p.h, p.m)}`;
  }
}

/** "20261028-060000" for a Date, in local time (what you'd expect to read). */
export function runIdFor(d: Date) {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

export function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h${pad(Math.floor((s % 3600) / 60))}m`;
}

// ── $TV_OUTPUT ────────────────────────────────────────────────────────────

/**
 * GitHub's $GITHUB_OUTPUT format: `key=value` lines, or `key<<EOF`, lines,
 * `EOF` for multi-line values. Later keys win; malformed lines are skipped.
 */
export function parseOutputs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heredoc = /^([^=<\s]+)<<(\S+)$/.exec(line);
    if (heredoc) {
      const [, key, delim] = heredoc;
      const end = lines.indexOf(delim, i + 1);
      if (end < 0) break;
      if (KEY.test(key)) out[key] = lines.slice(i + 1, end).join("\n");
      i = end;
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (KEY.test(key)) out[key] = line.slice(eq + 1);
  }
  return out;
}
