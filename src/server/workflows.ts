import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Cron } from "croner";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  DEFAULT_KEEP_RUNS,
  DEFAULT_TIMEOUT_MIN,
  envName,
  type Input,
  KEY,
  MAX_KEEP_RUNS,
  MAX_TIMEOUT_MIN,
  RECENT_RUNS,
  REPO_WORKFLOWS,
  type Run,
  RUN_ID,
  type RunFiles,
  runIdFor,
  slugify,
  type Step,
  type Workflow,
  type WorkflowSummary,
} from "@/lib/workflows";
import {
  alive,
  DATA_DIR,
  migrateLegacyData,
  readJson,
  writeJson,
} from "./data";
import { ROOT, SEGMENT, SKIP, toAbsolute } from "./repos";
import { cleanEnv, tildify } from "./tmux";

// Everything lives in files, on purpose: the scheduler (loaded by server.ts)
// and the API routes (bundled by Next) are separate copies of this module, and
// each run is its own detached process that outlives server restarts. File
// writes are synchronous, so a read-modify-write never interleaves with
// another one in this process.
//
// Workflow files are the user's: committed in a repo (.thunder/workflows/) or
// local (DATA_DIR/workflows/, with a `dir:`). We only ever read them, apart
// from writing a template when one is made. What we know about them that
// isn't in the file (paused, how far the schedule has fired) is state.json.

const home = os.homedir();
const LOCAL_DIR = path.join(DATA_DIR, "workflows");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const RUNS_DIR = path.join(DATA_DIR, "runs");
const WORKTREES_DIR = path.join(DATA_DIR, "worktrees");
/** The detached process that runs one workflow and records how it went. */
const RUNNER = path.join(
  /*turbopackIgnore: true*/ process.cwd(),
  "src/server/workflow-runner.ts",
);
/** tv-claude lives here; steps get it on PATH. */
const BIN_DIR = path.join(/*turbopackIgnore: true*/ process.cwd(), "bin");
/** Handed to Claude when it helps write a workflow. */
export const WORKFLOW_DOCS = tildify(
  path.join(/*turbopackIgnore: true*/ process.cwd(), "docs/workflows.md"),
);

/** What the runner needs, written next to run.json before it starts. */
export type RunSpec = {
  name: string;
  /** The folder steps run in, or the repo a worktree is added to. */
  dir: string;
  worktree: { path: string; branch: string; base: string | null } | null;
  steps: Step[];
  env: Record<string, string>;
  timeoutMin: number;
};

// ── Workflow files ────────────────────────────────────────────────────────

const Scalar = z.union([z.string(), z.number(), z.boolean()]).transform(String);

const FileSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    dir: z
      .string({
        // A bare ~ is YAML for null.
        error: (iss) =>
          iss.input === null ? 'put it in quotes: "~"' : undefined,
      })
      .trim()
      .min(1)
      .optional(),
    schedule: z.string().trim().nullable().optional(),
    inputs: z
      .union([
        z.array(
          z.string().regex(KEY, "Input names are letters, digits, _ and -"),
        ),
        z.record(
          z.string().regex(KEY, "Input names are letters, digits, _ and -"),
          z
            .union([
              z
                .object({
                  description: z.string().optional(),
                  default: Scalar.optional(),
                })
                .strict(),
              Scalar,
            ])
            .nullable(),
        ),
      ])
      .optional(),
    worktree: z
      .union([
        z.boolean(),
        z.object({ base: z.string().trim().min(1).optional() }).strict(),
      ])
      .optional(),
    timeout: z.number().int().min(1).max(MAX_TIMEOUT_MIN).optional(),
    keep: z.number().int().min(1).max(MAX_KEEP_RUNS).optional(),
    steps: z
      .array(
        z.union([
          z.string().min(1),
          z
            .object({
              id: z
                .string()
                .regex(/^[\w-]{1,64}$/, "Step ids are letters, digits, _ and -")
                .optional(),
              run: z.string().min(1, "A step needs something to run"),
            })
            .strict(),
        ]),
      )
      .min(1, "A workflow needs at least one step"),
  })
  .strict();

function cronError(schedule: string) {
  if (schedule.split(/\s+/).length !== 5) {
    return "schedule: use five cron fields (minute hour day month weekday)";
  }
  try {
    new Cron(schedule);
    return null;
  } catch (err) {
    return `schedule: ${err instanceof Error ? err.message : "not valid"}`;
  }
}

const isGitRepo = (dir: string) => existsSync(path.join(dir, ".git"));

type Source = { file: string; repo: string | null; dir: string; id: string };

/** Everything after the file's been found: parse, check, fill in defaults. */
function load(src: Source): Workflow {
  const stem = path.basename(src.file).replace(/\.ya?ml$/, "");
  const base: Workflow = {
    id: src.id,
    name: stem,
    file: tildify(src.file),
    repo: src.repo,
    dir: tildify(src.dir),
    schedule: null,
    inputs: [],
    worktree: null,
    timeoutMin: DEFAULT_TIMEOUT_MIN,
    keepRuns: DEFAULT_KEEP_RUNS,
    steps: [],
  };
  const fail = (error: string): Workflow => ({ ...base, error });

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(src.file, "utf8"));
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Not valid YAML");
  }
  const parsed = FileSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.join(".");
    return fail(where ? `${where}: ${issue.message}` : issue.message);
  }
  const f = parsed.data;

  let dir = src.dir;
  if (src.repo === null) {
    if (!f.dir)
      return fail("dir: a local workflow says which folder it runs in");
    dir = toAbsolute(f.dir);
  } else if (f.dir) {
    return fail("dir: a repo's workflows run in that repo; leave dir out");
  }

  const schedule = f.schedule ? f.schedule.replace(/\s+/g, " ") : null;
  const bad = schedule && cronError(schedule);
  if (bad) return fail(bad);

  const inputs: Input[] = Array.isArray(f.inputs)
    ? f.inputs.map((name) => ({ name, default: "" }))
    : Object.entries(f.inputs ?? {}).map(([name, v]) =>
        typeof v === "string"
          ? { name, default: v }
          : { name, description: v?.description, default: v?.default ?? "" },
      );

  // Repos default to a worktree per run; a local folder may not be a repo.
  const wantsWorktree = f.worktree ?? src.repo !== null;
  if (wantsWorktree && !isGitRepo(dir)) {
    return fail(
      `worktree: ${tildify(dir)} isn't a git repo (set worktree: false)`,
    );
  }

  const steps: Step[] = [];
  for (const [i, s] of f.steps.entries()) {
    const step = typeof s === "string" ? { run: s } : s;
    const id = step.id ?? `step-${i + 1}`;
    if (steps.some((x) => x.id === id)) {
      return fail(`steps.${i}.id: "${id}" is used twice`);
    }
    steps.push({ id, run: step.run });
  }

  return {
    ...base,
    name: f.name ?? stem,
    dir: tildify(dir),
    schedule,
    inputs,
    worktree: wantsWorktree
      ? {
          base:
            typeof f.worktree === "object" ? (f.worktree.base ?? null) : null,
        }
      : null,
    timeoutMin: f.timeout ?? DEFAULT_TIMEOUT_MIN,
    keepRuns: f.keep ?? DEFAULT_KEEP_RUNS,
    steps,
  };
}

const yamlFiles = (dir: string) => {
  try {
    return readdirSync(dir)
      .filter((f) => /^[\w.-]+\.ya?ml$/.test(f) && !f.startsWith("."))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
};

function subdirs(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(
        (e) => e.isDirectory() && SEGMENT.test(e.name) && !SKIP.has(e.name),
      )
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Folders under ROOT, the palette's two levels, that have workflows. */
function repoSources(): Source[] {
  const rels = subdirs(ROOT).flatMap((top) => [
    top,
    ...subdirs(path.join(ROOT, top)).map((c) => `${top}/${c}`),
  ]);
  return rels.flatMap((rel) => {
    const dir = path.join(ROOT, rel);
    return yamlFiles(path.join(dir, REPO_WORKFLOWS)).map((file) => ({
      file,
      repo: rel,
      dir,
      id: `${slugify(rel)}--${slugify(path.basename(file).replace(/\.ya?ml$/, ""))}`,
    }));
  });
}

function localSources(): Source[] {
  return yamlFiles(LOCAL_DIR).map((file) => ({
    file,
    repo: null,
    dir: home,
    id: `local--${slugify(path.basename(file).replace(/\.ya?ml$/, ""))}`,
  }));
}

/** Rescanning on every 2s poll is cheap, but not free. */
const CACHE_MS = 3000;
let cache: { at: number; workflows: Workflow[] } | null = null;

export function listWorkflows(): Workflow[] {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.workflows;
  const seen = new Set<string>();
  const workflows = [...repoSources(), ...localSources()].map((src) => {
    // "a-b/c" and "a/b-c" slug alike; keep both.
    let id = src.id;
    for (let n = 2; seen.has(id); n++) id = `${src.id}-${n}`;
    seen.add(id);
    return load({ ...src, id });
  });
  cache = { at: Date.now(), workflows };
  return workflows;
}

export function getWorkflow(id: string) {
  return listWorkflows().find((w) => w.id === id) ?? null;
}

// ── State: paused, and how far the schedule has fired ─────────────────────

type State = {
  enabled: boolean;
  /**
   * The scheduler has fired everything due up to here. Saved, so a restart
   * never fires twice; reset when the schedule changes or it's unpaused, so
   * those never fire for a time in the past.
   */
  scheduledThrough: string;
  /** The schedule scheduledThrough counts for. */
  schedule: string | null;
};

const readState = () => readJson<Record<string, State>>(STATE_FILE) ?? {};

function updateState<T>(fn: (state: Record<string, State>) => T): T {
  const state = readState();
  const result = fn(state);
  writeJson(STATE_FILE, state);
  return result;
}

const fresh = (wf: Workflow, enabled = true): State => ({
  enabled,
  scheduledThrough: new Date().toISOString(),
  schedule: wf.schedule,
});

/**
 * Its state, started from now if it's new or its schedule changed. A repo's
 * workflow starts paused: cloning or pulling a repo must never put its code
 * on a timer. You turn it on once, in the UI.
 */
export function stateOf(wf: Workflow, all = readState()): State {
  const s = all[wf.id];
  if (s && s.schedule === wf.schedule) return s;
  return fresh(wf, s?.enabled ?? wf.repo === null);
}

/** Saves stateOf() for a workflow whose file changed under it. */
function syncState(wf: Workflow) {
  return updateState((all) => (all[wf.id] = stateOf(wf, all)));
}

export function setEnabled(wf: Workflow, enabled: boolean) {
  updateState((all) => {
    const s = stateOf(wf, all);
    all[wf.id] = enabled && !s.enabled ? fresh(wf) : { ...s, enabled };
  });
}

export function nextRunAt(
  wf: Workflow,
  state = stateOf(wf),
  after = new Date(),
) {
  if (!wf.schedule || !state.enabled || wf.error) return null;
  try {
    return new Cron(wf.schedule).nextRun(after)?.getTime() ?? null;
  } catch {
    return null;
  }
}

/**
 * For the scheduler: the first time due after scheduledThrough, if that's
 * already passed. Marks it fired before returning, so a crash right after
 * can't fire it twice.
 */
export function takeDue(wf: Workflow, now = new Date()) {
  if (!wf.schedule || wf.error) return null;
  const s = syncState(wf);
  if (!s.enabled) return null;
  let due: Date | null = null;
  try {
    due = new Cron(wf.schedule).nextRun(new Date(s.scheduledThrough));
  } catch {
    return null;
  }
  if (!due || due > now) return null;
  updateState((all) => {
    all[wf.id] = { ...stateOf(wf, all), scheduledThrough: now.toISOString() };
  });
  return due;
}

export function summaries(): WorkflowSummary[] {
  const state = readState();
  return listWorkflows().map((wf) => {
    const s = stateOf(wf, state);
    const runs = listRuns(wf.id, RECENT_RUNS);
    const running = runs.find((r) => r.status === "running");
    const step = running?.steps.findIndex((x) => x.status === "running") ?? -1;
    return {
      ...wf,
      enabled: s.enabled,
      nextRunAt: nextRunAt(wf, s),
      recent: runs
        .map(({ id, status, startedAt, endedAt, trigger }) => ({
          id,
          status,
          startedAt,
          endedAt,
          trigger,
        }))
        .reverse(),
      ...(running && {
        progress: {
          run: running.id,
          step: Math.max(0, step),
          of: running.steps.length,
          id: running.steps[step]?.id ?? "setup",
        },
      }),
      lastPr: runs.find((r) => r.outputs?.pr)?.outputs.pr,
    };
  });
}

// ── Making one ────────────────────────────────────────────────────────────

export class WorkflowError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** A repo under ROOT (the palette's two levels) that discovery will scan. */
function repoRel(abs: string) {
  const rel = path.relative(ROOT, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  if (rel.split(path.sep).length > 2 || !isGitRepo(abs)) return null;
  return rel;
}

const template = (name: string, opts: { dir?: string; worktree: boolean }) =>
  `# ${name}: a Thunder Vision workflow. Each step is a shell script, run in
# your login shell; a non-zero exit stops the run (78 stops it as "no
# changes"). Steps get these variables:
#   TV_INPUT_<NAME>  the inputs below, as given when you press Run
#   TV_OUTPUT        a file: write key=value lines; later steps read them
#                    as TV_OUT_<KEY>, and "pr=<url>" shows on the run
#   TV_SUMMARY       a file: markdown shown at the top of the run
#   TV_ARTIFACTS     a folder: files to keep with the run
#   TV_BRANCH        the run's branch, when it has a worktree
# tv-claude runs Claude headless (claude -p, auto mode) with a readable log.

name: ${JSON.stringify(name)}
${opts.dir ? `dir: ${JSON.stringify(opts.dir)}\n` : ""}
# Five-field cron in this Mac's local time; leave it out to run by hand only.
# schedule: "0 6 * * 1-5"

# Asked for when you press Run; scheduled runs get the defaults.
# inputs:
#   task:
#     description: What to work on
#     default: ""

${
  opts.worktree
    ? `# A fresh git worktree per run, on branch tv/<file>/<run>, from origin's
# default branch (or base: <branch>). Removed when the run succeeds; kept
# when it fails, so you can pick it up. false runs in the folder itself.
worktree: true`
    : `# true would give each run its own git worktree (the folder must be a repo).
worktree: false`
}

timeout: ${DEFAULT_TIMEOUT_MIN} # minutes, for the whole run

steps:
  - id: hello
    run: |
      echo "Hello from $TV_WORKFLOW, run $TV_RUN"
      # tv-claude "/my-command $TV_INPUT_TASK"
      # git push -u origin HEAD && echo "pr=$(gh pr create --fill)" >> "$TV_OUTPUT"
`;

/**
 * Writes a commented template: in the repo (.thunder/workflows/) when the
 * folder is one discovery scans, else a local workflow pointing at it.
 */
export function createWorkflow(dirInput: string, name: string) {
  const abs = toAbsolute(dirInput);
  if (!statSync(abs, { throwIfNoEntry: false })?.isDirectory()) {
    throw new WorkflowError(`${tildify(abs)} isn't a folder`);
  }
  const stem = slugify(name);
  const rel = repoRel(abs);
  let file: string;
  if (rel !== null) {
    file = path.join(abs, REPO_WORKFLOWS, `${stem}.yml`);
    if (
      existsSync(/*turbopackIgnore: true*/ file) ||
      existsSync(/*turbopackIgnore: true*/ file.replace(/\.yml$/, ".yaml"))
    ) {
      throw new WorkflowError(`${tildify(file)} already exists`, 409);
    }
  } else {
    file = path.join(LOCAL_DIR, `${stem}.yml`);
    for (let n = 2; existsSync(/*turbopackIgnore: true*/ file); n++) {
      file = path.join(LOCAL_DIR, `${stem}-${n}.yml`);
    }
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    template(name, {
      dir: rel === null ? tildify(abs) : undefined,
      worktree: rel !== null,
    }),
  );
  cache = null;
  const wf = listWorkflows().find((w) => w.file === tildify(file));
  return { id: wf?.id ?? null, file: tildify(file) };
}

// ── Runs ──────────────────────────────────────────────────────────────────

const runsDir = (wfId: string) => path.join(RUNS_DIR, wfId);
export const runDir = (wfId: string, runId: string) =>
  path.join(RUNS_DIR, wfId, runId);
const runFile = (wfId: string, runId: string) =>
  path.join(runDir(wfId, runId), "run.json");
export const logFile = (wfId: string, runId: string) =>
  path.join(runDir(wfId, runId), "output.log");

function runIds(wfId: string) {
  try {
    return readdirSync(runsDir(wfId))
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
  const fresh = readJson<Run>(runFile(run.workflowId, run.id));
  if (fresh && fresh.status !== "running") return fresh;
  const endedAt = new Date().toISOString();
  const lost: Run = {
    ...run,
    status: "lost",
    endedAt,
    note: "The runner stopped before the workflow finished (crash or reboot?)",
    steps: run.steps.map((s) =>
      s.status === "running" ? { ...s, status: "lost", endedAt } : s,
    ),
    ...(run.worktree &&
      run.worktree.state !== "removed" && {
        worktree: { ...run.worktree, state: "kept" },
      }),
  };
  writeJson(runFile(run.workflowId, run.id), lost);
  return lost;
}

export function getRun(wfId: string, runId: string) {
  if (!RUN_ID.test(runId)) return null;
  const run = readJson<Run>(runFile(wfId, runId));
  // Hand-edited or half-written: skip it rather than break every listing.
  if (!run || typeof run !== "object" || !Array.isArray(run.steps)) return null;
  return settle(run);
}

/** Newest first. */
export function listRuns(wfId: string, limit = Infinity): Run[] {
  const runs: Run[] = [];
  for (const id of runIds(wfId)) {
    if (runs.length >= limit) break;
    const run = getRun(wfId, id);
    if (run) runs.push(run);
  }
  return runs;
}

export function activeRun(wfId: string) {
  return listRuns(wfId, 5).find((r) => r.status === "running") ?? null;
}

/** Settles every run whose runner died while the server was down. */
export function settleAll() {
  for (const wf of listWorkflows()) listRuns(wf.id, 5);
}

const isFile = (p: string) =>
  statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;

/** The summary (TV_SUMMARY) and what's in TV_ARTIFACTS. */
export function runFiles(wfId: string, runId: string): RunFiles {
  const dir = runDir(wfId, runId);
  let summary: string | null = null;
  try {
    summary = readFileSync(path.join(dir, "summary.md"), "utf8").trim() || null;
  } catch {}
  const root = path.join(dir, "artifacts");
  const artifacts: RunFiles["artifacts"] = [];
  const walk = (rel: string) => {
    let entries;
    try {
      entries = readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && artifacts.length < 200) {
        artifacts.push({ path: p, size: statSync(path.join(root, p)).size });
      }
    }
  };
  walk("");
  return {
    summary,
    artifacts: artifacts.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/** An artifact's real path, or null if it isn't one (or points outside). */
export function artifactPath(wfId: string, runId: string, rel: string) {
  const root = path.join(runDir(wfId, runId), "artifacts");
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep) || !isFile(file)) return null;
  // A step could leave a symlink to anywhere; only serve what's really here.
  if (lstatSync(file).isSymbolicLink()) return null;
  try {
    const real = realpathSync(file);
    return real.startsWith(realpathSync(root) + path.sep) ? real : null;
  } catch {
    return null;
  }
}

function newRunId(wfId: string, now: Date) {
  const base = runIdFor(now);
  let id = base;
  for (let n = 2; existsSync(runDir(wfId, id)); n++) id = `${base}-${n}`;
  return id;
}

/** ~/.local/bin isn't on a login shell's PATH (it's added in .zshrc). */
function claudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const local = path.join(home, ".local/bin/claude");
  return existsSync(local) ? local : "claude";
}

function baseEnv() {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(cleanEnv())) {
    if (v !== undefined) env[k] = v;
  }
  return env;
}

function specFor(wf: Workflow, run: Run): RunSpec {
  const env = baseEnv();
  const claude = claudeBin();
  const dirs = [BIN_DIR];
  if (claude.includes("/")) dirs.push(path.dirname(claude));
  env.PATH = [...dirs, env.PATH ?? "/usr/bin:/bin"].join(":");
  env.TV_CLAUDE_BIN = claude;
  env.TV_WORKFLOW = wf.id;
  env.TV_RUN = run.id;
  env.TV_TRIGGER = run.trigger;
  for (const [k, v] of Object.entries(run.inputs))
    env[envName("TV_INPUT_", k)] = v;
  const stem = path.basename(wf.file).replace(/\.ya?ml$/, "");
  return {
    name: wf.name,
    dir: toAbsolute(wf.dir),
    worktree: wf.worktree && {
      path: path.join(WORKTREES_DIR, wf.id, run.id),
      branch: `tv/${slugify(stem)}/${run.id}`,
      base: wf.worktree.base,
    },
    steps: wf.steps,
    env,
    timeoutMin: wf.timeoutMin,
  };
}

/**
 * Starts a run in the background. A scheduled one is recorded as skipped if
 * the last is still going; a missing folder records a failed one.
 */
export function startRun(
  wf: Workflow,
  trigger: Run["trigger"],
  given: Record<string, unknown> = {},
): Run {
  const now = new Date();
  const id = newRunId(wf.id, now);
  const inputs: Record<string, string> = {};
  for (const input of wf.inputs) {
    const v = given[input.name];
    inputs[input.name] = typeof v === "string" ? v : input.default;
  }
  const base: Run = {
    id,
    workflowId: wf.id,
    trigger,
    status: "running",
    startedAt: now.toISOString(),
    inputs,
    outputs: {},
    steps: wf.steps.map((s) => ({ id: s.id, status: "pending" })),
  };
  const done = (status: Run["status"], note: string) => {
    const run: Run = { ...base, status, note, endedAt: base.startedAt };
    writeJson(runFile(wf.id, id), run);
    return run;
  };

  if (wf.error) return done("failed", wf.error);
  const busy = activeRun(wf.id);
  if (busy && (trigger !== "manual" || !wf.worktree)) {
    return done("skipped", `Run ${busy.id} was still going`);
  }
  if (!statSync(toAbsolute(wf.dir), { throwIfNoEntry: false })?.isDirectory()) {
    return done("failed", `Folder ${wf.dir} doesn't exist`);
  }

  const dir = runDir(wf.id, id);
  const spec = specFor(wf, base);
  writeJson(path.join(dir, "spec.json"), spec);
  writeJson(runFile(wf.id, id), base);
  // Its own session and process group: survives server restarts (and
  // launchd's cleanup of the server's group), and can be stopped as a whole.
  const child = spawn(process.execPath, ["--import", "tsx", RUNNER, dir], {
    cwd: /*turbopackIgnore: true*/ process.cwd(),
    detached: true,
    stdio: "ignore",
    env: cleanEnv(),
  });
  child.on("error", (err) => {
    writeJson(runFile(wf.id, id), {
      ...base,
      status: "failed",
      endedAt: new Date().toISOString(),
      note: `Couldn't start the runner: ${err.message}`,
    } satisfies Run);
  });
  child.unref();
  // Synchronously, before the runner has booted and read it back.
  const run: Run = { ...base, pid: child.pid };
  writeJson(runFile(wf.id, id), run);
  prune(wf);
  return run;
}

/** Asks the runner to stop; it kills the step and records "stopped". */
export function stopRun(wfId: string, runId: string) {
  const run = getRun(wfId, runId);
  if (run?.status !== "running" || !run.pid) return false;
  try {
    process.kill(run.pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, {
    cwd,
    env: { ...cleanEnv(), GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  }).toString();
}

/** Removes a kept worktree and its local branch (pushed work is on the remote). */
export function discardWorktree(wfId: string, runId: string) {
  const run = getRun(wfId, runId);
  const wt = run?.worktree;
  if (!run || run.status === "running" || !wt || wt.state === "removed") {
    return false;
  }
  if (existsSync(wt.repo)) {
    try {
      git(wt.repo, ["worktree", "remove", "--force", wt.path]);
    } catch {
      rmSync(wt.path, { recursive: true, force: true });
      try {
        git(wt.repo, ["worktree", "prune"]);
      } catch {}
    }
    try {
      git(wt.repo, ["branch", "-D", wt.branch]);
    } catch {}
  } else {
    rmSync(wt.path, { recursive: true, force: true });
  }
  writeJson(runFile(wfId, runId), {
    ...run,
    worktree: { ...wt, state: "removed", branchKept: false },
  } satisfies Run);
  return true;
}

const keptWorktree = (run: Run | null) =>
  !!run?.worktree && run.worktree.state !== "removed";

/**
 * Keeps the newest `keepRuns`. A running run is never deleted, nor one
 * whose worktree was kept: that's work you haven't looked at yet.
 */
function prune(wf: Workflow) {
  for (const id of runIds(wf.id).slice(wf.keepRuns)) {
    const run = getRun(wf.id, id);
    if (run && run.status !== "running" && !keptWorktree(run)) {
      deleteRun(wf.id, id);
    }
  }
}

/** A finished run, with its worktree if it kept one. */
export function deleteRun(wfId: string, runId: string) {
  const run = getRun(wfId, runId);
  if (!run || run.status === "running") return false;
  if (keptWorktree(run)) discardWorktree(wfId, runId);
  rmSync(runDir(wfId, runId), { recursive: true, force: true });
  return true;
}

/** Every finished run; a running one stays. */
export function clearRuns(wfId: string) {
  for (const id of runIds(wfId)) deleteRun(wfId, id);
}

/** Called once by the server at boot, before the scheduler. */
export function migrate() {
  migrateLegacyData({
    set: (id, s) =>
      updateState((all) => {
        const wf = getWorkflowUncached(id);
        all[id] = { ...s, schedule: wf?.schedule ?? null };
      }),
  });
}

function getWorkflowUncached(id: string) {
  cache = null;
  return getWorkflow(id);
}
