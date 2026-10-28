import { ID, RUN_ID } from "@/lib/workflows";
import { body, crossSite, error, noStore } from "@/server/http";
import {
  activeRun,
  clearRuns,
  deleteRun,
  discardWorktree,
  getRun,
  getWorkflow,
  listRuns,
  runFiles,
  startRun,
  stopRun,
} from "@/server/workflows";

const workflowFrom = (id: unknown) =>
  typeof id === "string" && ID.test(id) ? getWorkflow(id) : null;

const runs = (wfId: string, extra?: object) =>
  Response.json({ ...extra, runs: listRuns(wfId) }, { headers: noStore });

/**
 * ?workflow=<id> → its runs, newest first.
 * ?workflow=<id>&run=<id> → that run, with its summary and artifact list.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const wf = workflowFrom(params.get("workflow"));
  if (!wf) return error(404, "No such workflow");
  const runId = params.get("run");
  if (runId === null) {
    return Response.json(listRuns(wf.id), { headers: noStore });
  }
  const run = RUN_ID.test(runId) ? getRun(wf.id, runId) : null;
  if (!run) return error(404, "No such run");
  return Response.json(
    { run, ...runFiles(wf.id, run.id) },
    { headers: noStore },
  );
}

/** { workflow, inputs? } → run it now. */
export async function POST(req: Request) {
  if (crossSite(req)) return error(403, "cross-site request");
  const input = await body(req);
  const wf = workflowFrom(input.workflow);
  if (!wf) return error(404, "No such workflow");
  if (wf.error) return error(400, `Fix ${wf.file} first: ${wf.error}`);
  // Runs in the folder itself can't overlap; worktree runs can.
  const busy = !wf.worktree && activeRun(wf.id);
  if (busy) return error(409, `Run ${busy.id} is still going`);
  const given =
    input.inputs && typeof input.inputs === "object"
      ? (input.inputs as Record<string, unknown>)
      : {};
  const run = startRun(wf, "manual", given);
  return runs(wf.id, { run });
}

/** { workflow, run, action: "stop" | "discard" } */
export async function PATCH(req: Request) {
  if (crossSite(req)) return error(403, "cross-site request");
  const input = await body(req);
  const wf = workflowFrom(input.workflow);
  const runId = typeof input.run === "string" ? input.run : "";
  if (!wf || !RUN_ID.test(runId) || !getRun(wf.id, runId)) {
    return error(404, "No such run");
  }
  if (input.action === "stop") {
    if (!stopRun(wf.id, runId)) return error(409, "That run isn't running");
  } else if (input.action === "discard") {
    if (!discardWorktree(wf.id, runId)) {
      return error(409, "That run has no worktree to discard");
    }
  } else {
    return error(400, 'action is "stop" or "discard"');
  }
  return runs(wf.id);
}

/** { workflow, run? } → delete one finished run, or all of them. */
export async function DELETE(req: Request) {
  if (crossSite(req)) return error(403, "cross-site request");
  const input = await body(req);
  const wf = workflowFrom(input.workflow);
  if (!wf) return error(404, "No such workflow");
  if (input.run === undefined) clearRuns(wf.id);
  else if (
    typeof input.run !== "string" ||
    !RUN_ID.test(input.run) ||
    !deleteRun(wf.id, input.run)
  ) {
    return error(409, "Only a finished run can be deleted");
  }
  return runs(wf.id);
}
