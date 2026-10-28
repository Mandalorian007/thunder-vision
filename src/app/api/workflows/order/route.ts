import { body, crossSite, error, noStore } from "@/server/http";
import { setWorkflowOrder, summaries } from "@/server/workflows";

/** { ids } → the sidebar order, top first. Unknown ids are dropped. */
export async function PUT(req: Request) {
  if (crossSite(req)) return error(403, "cross-site request");
  const { ids } = await body(req);
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
    return error(400, "ids is required");
  }
  setWorkflowOrder(ids);
  return Response.json({ workflows: summaries() }, { headers: noStore });
}
