import { statSync } from "node:fs";
import { z } from "zod";
import {
  DEFAULT_KEEP_RUNS,
  DEFAULT_TIMEOUT_MIN,
  EFFORTS,
  ID,
  type Job,
  MAX_KEEP_RUNS,
  MAX_TIMEOUT_MIN,
  MODELS,
  slugify,
} from "@/lib/jobs";
import { body, crossSite, error, noStore } from "@/server/http";
import {
  checkCron,
  deleteJob,
  getJob,
  readJobs,
  summaries,
  updateJobs,
} from "@/server/jobs";
import { toAbsolute } from "@/server/repos";
import { tildify } from "@/server/tmux";

function cronError(schedule: string) {
  if (schedule.split(/\s+/).length !== 5) {
    return "Use five cron fields: minute hour day month weekday";
  }
  try {
    checkCron(schedule);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Not a valid schedule";
  }
}

const text = (what: string) =>
  z.string().trim().min(1, `${what} is required`).max(4000);

const Fields = z.object({
  name: text("Name").max(64),
  dir: text("Folder"),
  schedule: z
    .string()
    .trim()
    .transform((s) => s.replace(/\s+/g, " "))
    .superRefine((s, ctx) => {
      const message = cronError(s);
      if (message) ctx.addIssue({ code: "custom", message });
    }),
  enabled: z.boolean().default(true),
  timeoutMin: z
    .number()
    .int()
    .min(1, "Timeout is at least 1 minute")
    .max(MAX_TIMEOUT_MIN, `Timeout is at most ${MAX_TIMEOUT_MIN} minutes`)
    .default(DEFAULT_TIMEOUT_MIN),
  keepRuns: z
    .number()
    .int()
    .min(1, "Keep at least 1 run")
    .max(MAX_KEEP_RUNS, `Keep at most ${MAX_KEEP_RUNS} runs`)
    .default(DEFAULT_KEEP_RUNS),
  task: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("claude"),
      prompt: text("Prompt"),
      model: z.enum(MODELS).default("sonnet"),
      effort: z.enum(EFFORTS).default("medium"),
    }),
    z.object({ kind: z.literal("shell"), command: text("Command") }),
  ]),
});

/** Parsed fields, or an error response saying what's wrong. */
function parse(input: unknown) {
  const result = Fields.safeParse(input);
  if (!result.success) return error(400, result.error.issues[0].message);
  const abs = toAbsolute(result.data.dir);
  if (!statSync(abs, { throwIfNoEntry: false })?.isDirectory()) {
    return error(400, `${tildify(abs)} isn't a folder`);
  }
  return result.data;
}

const list = (status = 200, extra?: object) =>
  Response.json({ ...extra, jobs: summaries() }, { status, headers: noStore });

export async function GET() {
  return Response.json(summaries(), { headers: noStore });
}

/** { name, dir, schedule, task, enabled?, timeoutMin?, keepRuns? } → new job. */
export async function POST(req: Request) {
  if (crossSite(req)) return error(403, "cross-site request");
  const fields = parse(await body(req));
  if (fields instanceof Response) return fields;
  const job = updateJobs((jobs) => {
    const base = slugify(fields.name);
    let id = base;
    for (let n = 2; jobs.some((j) => j.id === id); n++) id = `${base}-${n}`;
    const job: Job = {
      id,
      ...fields,
      scheduledThrough: new Date().toISOString(),
    };
    jobs.push(job);
    return job;
  });
  return list(201, { id: job.id });
}

/** { id, ...fields to change } → updated job. */
export async function PATCH(req: Request) {
  if (crossSite(req)) return error(403, "cross-site request");
  const { id, ...changes } = await body(req);
  const job = typeof id === "string" ? getJob(id) : null;
  if (!job) return error(404, "No such job");
  const fields = parse({ ...job, ...changes });
  if (fields instanceof Response) return fields;
  const ok = updateJobs((jobs) => {
    const i = jobs.findIndex((j) => j.id === job.id);
    if (i < 0) return false;
    const prev = jobs[i];
    // A new schedule (or unpausing) counts from now, never from the past.
    const restart =
      fields.schedule !== prev.schedule || (fields.enabled && !prev.enabled);
    jobs[i] = {
      ...prev,
      ...fields,
      scheduledThrough: restart
        ? new Date().toISOString()
        : prev.scheduledThrough,
    };
    return true;
  });
  return ok ? list() : error(404, "No such job");
}

/** { id, history? } → deletes the job; history: true deletes its runs too. */
export async function DELETE(req: Request) {
  if (crossSite(req)) return error(403, "cross-site request");
  const { id, history } = await body(req);
  if (
    typeof id !== "string" ||
    !ID.test(id) ||
    !readJobs().some((j) => j.id === id)
  ) {
    return error(404, "No such job");
  }
  deleteJob(id, history === true);
  return list();
}
