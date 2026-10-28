import { ID } from "@/lib/workflows";
import { body, crossSite, error, noStore } from "@/server/http";
import {
  createWorkflow,
  getWorkflow,
  setEnabled,
  summaries,
  WorkflowError,
} from "@/server/workflows";

const list = (status = 200, extra?: object) =>
  Response.json(
    { ...extra, workflows: summaries() },
    { status, headers: noStore },
  );

export async function GET() {
  return Response.json(summaries(), { headers: noStore });
}

/** { dir, name } → writes a template workflow file; returns where. */
export async function POST(req: Request) {
  if (crossSite(req)) return error(403, "cross-site request");
  const { dir, name } = await body(req);
  if (typeof dir !== "string" || !dir.trim()) {
    return error(400, "Folder is required");
  }
  if (typeof name !== "string" || !name.trim() || name.length > 80) {
    return error(400, "Name is required");
  }
  try {
    const made = createWorkflow(dir, name.trim());
    return list(201, made);
  } catch (err) {
    if (err instanceof WorkflowError) return error(err.status, err.message);
    throw err;
  }
}

/** { id, enabled } → pause or resume its schedule. */
export async function PATCH(req: Request) {
  if (crossSite(req)) return error(403, "cross-site request");
  const { id, enabled } = await body(req);
  const wf = typeof id === "string" && ID.test(id) ? getWorkflow(id) : null;
  if (!wf) return error(404, "No such workflow");
  if (typeof enabled !== "boolean") return error(400, "enabled is required");
  setEnabled(wf, enabled);
  return list();
}
