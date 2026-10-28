import { body, crossSite, error, noStore } from "@/server/http";
import { exitCopyMode, hasSession, listSessions } from "@/server/tmux";

/** { name } → out of copy mode, back to live output. */
export async function POST(req: Request) {
  if (crossSite(req)) return error(403, "cross-site request");
  const { name } = await body(req);
  if (typeof name !== "string" || !(await hasSession(name))) {
    return error(404, "No such session");
  }
  await exitCopyMode(name);
  return Response.json(
    { sessions: await listSessions() },
    { headers: noStore },
  );
}
