import { body, crossSite, error, noStore } from "@/server/http";
import { listSessions, setSessionOrder } from "@/server/tmux";

/**
 * { names } → the sidebar order, top first. Names that aren't sessions are
 * dropped; sessions left out keep their age order after the rest.
 */
export async function PUT(req: Request) {
  if (crossSite(req)) return error(403, "cross-site request");
  const { names } = await body(req);
  if (!Array.isArray(names) || !names.every((n) => typeof n === "string")) {
    return error(400, "names is required");
  }
  const sessions = await listSessions();
  const known = new Set(sessions.map((s) => s.name));
  const listed = [...new Set(names as string[])].filter((n) => known.has(n));
  const rest = sessions.map((s) => s.name).filter((n) => !listed.includes(n));
  await setSessionOrder([...listed, ...rest]);
  return Response.json(
    { sessions: await listSessions() },
    { headers: noStore },
  );
}
