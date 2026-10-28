// Scheduled jobs: shared by the server (store, scheduler, runner) and the UI.
// No Node imports here; the browser bundle uses it too.

export const MODELS = ["sonnet", "opus", "fable"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Model = (typeof MODELS)[number];
export type Effort = (typeof EFFORTS)[number];

export const DEFAULT_TIMEOUT_MIN = 30;
export const MAX_TIMEOUT_MIN = 24 * 60;
export const DEFAULT_KEEP_RUNS = 50;
export const MAX_KEEP_RUNS = 500;

export type Task =
  | { kind: "claude"; prompt: string; model: Model; effort: Effort }
  | { kind: "shell"; command: string };

export type Job = {
  /** Slug from the name at creation; never changes, names the runs folder. */
  id: string;
  name: string;
  /** Like sessions: relative to TV_ROOT, or "~/…" / "/…". */
  dir: string;
  /** Cron, five fields: "0 6 * * *". */
  schedule: string;
  enabled: boolean;
  timeoutMin: number;
  keepRuns: number;
  task: Task;
  /**
   * The scheduler has fired everything due up to here. Saved, so a restart
   * never fires twice; reset on create, enable and schedule edits, so those
   * never fire for a time in the past.
   */
  scheduledThrough: string;
};

export type RunStatus =
  "running" | "ok" | "failed" | "timeout" | "cancelled" | "lost" | "skipped";

export type Run = {
  /** Start time, sortable: "20261028-060000". */
  id: string;
  jobId: string;
  trigger: "schedule" | "manual" | "catch-up";
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  /** The runner process; a dead pid on a "running" run means "lost". */
  pid?: number;
  exitCode?: number | null;
  /** Why it was skipped, lost or couldn't start. */
  note?: string;
  claude?: {
    sessionId?: string;
    /** The final message (or the last thing Claude said, if it never finished). */
    result?: string;
    turns?: number;
  };
};

/** What the sidebar and job header need, polled every few seconds. */
export type JobSummary = Job & {
  /** Epoch ms of the next scheduled run; null when paused. */
  nextRunAt: number | null;
  /** Newest last, at most RECENT_RUNS. */
  recent: Pick<Run, "id" | "status" | "startedAt" | "endedAt" | "trigger">[];
};

export const RECENT_RUNS = 20;

/** Job ids, run ids: safe as folder names and in URLs. */
export const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const RUN_ID = /^\d{8}-\d{6}(-\d+)?$/;

export function slugify(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "job"
  );
}

export const isDone = (s: RunStatus) => s !== "running";
export const isGreen = (s: RunStatus) => s === "ok";
export const isRed = (s: RunStatus) =>
  s === "failed" || s === "timeout" || s === "lost";

export const STATUS_LABEL: Record<RunStatus, string> = {
  running: "running",
  ok: "ok",
  failed: "failed",
  timeout: "timed out",
  cancelled: "stopped",
  lost: "lost",
  skipped: "skipped",
};

// ── Schedule presets ──────────────────────────────────────────────────────
// The form edits presets; jobs store plain cron. Anything that doesn't match a
// preset is shown and edited as raw cron.

export type Preset =
  | { kind: "minutes"; every: number; days: number[] }
  | { kind: "hourly"; minute: number; days: number[] }
  | { kind: "time"; time: string; days: number[] }
  | { kind: "cron"; cron: string };

export const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
export const WEEKDAYS = [1, 2, 3, 4, 5];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
/** "Every N minutes": steps that divide the hour evenly. */
export const MINUTE_STEPS = [5, 10, 15, 20, 30];

const pad = (n: number) => String(n).padStart(2, "0");

function hm(time: string) {
  const [h, m] = time.split(":").map(Number);
  return { h: h || 0, m: m || 0 };
}

/** [1,2,3,4,5] → "1-5", [1,3,5] → "1,3,5", all seven → "*". */
function dowField(days: number[]) {
  const d = [...new Set(days)].sort((a, b) => a - b);
  if (d.length === 0 || d.length === 7) return "*";
  const parts: string[] = [];
  for (let i = 0; i < d.length;) {
    let j = i;
    while (j + 1 < d.length && d[j + 1] === d[j] + 1) j++;
    // Runs of three or more read better as a range.
    if (j - i >= 2) parts.push(`${d[i]}-${d[j]}`);
    else for (let k = i; k <= j; k++) parts.push(String(d[k]));
    i = j + 1;
  }
  return parts.join(",");
}

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

export function presetToCron(p: Preset) {
  if (p.kind === "cron") return p.cron.trim().replace(/\s+/g, " ");
  const dow = dowField(p.days);
  if (p.kind === "minutes") return `*/${p.every} * * * ${dow}`;
  if (p.kind === "hourly") return `${p.minute} * * * ${dow}`;
  const { h, m } = hm(p.time);
  return `${m} ${h} * * ${dow}`;
}

const NUM = /^\d{1,2}$/;

export function cronToPreset(cron: string): Preset {
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
        return { kind: "time", time: `${pad(Number(hour))}:${pad(m)}`, days };
      }
    }
  }
  return { kind: "cron", cron };
}

/** "6:00" / "18:30", in the viewer's locale. */
function clock(time: string) {
  const { h, m } = hm(time);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "daily", "weekdays", "weekends", "Mondays", "Mon, Wed, Fri". */
function daysLabel(days: number[]) {
  const dow = dowField(days);
  if (dow === "*") return "daily";
  if (dow === "1-5") return "weekdays";
  if (dow === "0,6") return "weekends";
  if (days.length === 1) return `${DAYS[days[0]]}s`;
  return days.map((d) => DAYS[d].slice(0, 3)).join(", ");
}

export function describeSchedule(cron: string) {
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
      return `${daysLabel(p.days)} ${clock(p.time)}`;
  }
}

export function taskLabel(task: Task) {
  return task.kind === "claude" ? task.prompt : task.command;
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
