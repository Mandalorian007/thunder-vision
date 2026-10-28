import { ID, RUN_ID } from "@/lib/jobs";
import { body, crossSite, error, noStore } from "@/server/http";
import {
  clearRuns,
  deleteRun,
  getJob,
  getRun,
  listRuns,
  startRun,
  stopRun,
} from "@/server/jobs";

const jobFrom = (id: unknown) =>
  typeof id === "string" && ID.test(id) ? getJob(id) : null;

const runs = (jobId: string, extra?: object) =>
  Response.json({ ...extra, runs: listRuns(jobId) }, { headers: noStore });

/** ?job=<id> → that job's runs, newest first. */
export async function GET(req: Request) {
  const job = jobFrom(new URL(req.url).searchParams.get("job"));
  if (!job) return error(404, "No such job");
  return Response.json(listRuns(job.id), { headers: noStore });
}

/** { job } → run it now. */
export async function POST(req: Request) {
  if (crossSite(req)) return error(403, "cross-site request");
  const job = jobFrom((await body(req)).job);
  if (!job) return error(404, "No such job");
  const run = startRun(job, "manual");
  return runs(job.id, { run });
}

/** { job, run } → stop a running run. */
export async function PATCH(req: Request) {
  if (crossSite(req)) return error(403, "cross-site request");
  const input = await body(req);
  const job = jobFrom(input.job);
  const runId = typeof input.run === "string" ? input.run : "";
  if (!job || !RUN_ID.test(runId) || !getRun(job.id, runId)) {
    return error(404, "No such run");
  }
  if (!stopRun(job.id, runId)) return error(409, "That run isn't running");
  return runs(job.id);
}

/** { job, run? } → delete one finished run, or all of them. */
export async function DELETE(req: Request) {
  if (crossSite(req)) return error(403, "cross-site request");
  const input = await body(req);
  const job = jobFrom(input.job);
  if (!job) return error(404, "No such job");
  if (input.run === undefined) clearRuns(job.id);
  else if (typeof input.run !== "string" || !deleteRun(job.id, input.run)) {
    return error(409, "Only a finished run can be deleted");
  }
  return runs(job.id);
}
