import { EVERY_CHOICES } from "@/lib/overview";
import { body, crossSite, error, noStore } from "@/server/http";
import { refreshSession, setEvery } from "@/server/overview";
import { hasSession } from "@/server/tmux";

/**
 * { session } → summarize it now with Haiku (counts against your plan).
 * { session, every } → set its refresh interval in minutes; 0 is manual.
 */
export async function POST(req: Request) {
  if (crossSite(req)) return error(403, "cross-site request");
  const { session, every } = await body(req);
  if (typeof session !== "string") return error(400, "session is required");
  if (every !== undefined) {
    if (!(EVERY_CHOICES as readonly unknown[]).includes(every)) {
      return error(400, "every must be one of " + EVERY_CHOICES.join(", "));
    }
    if (!(await hasSession(session))) return error(404, "No such session");
    await setEvery(session, every as number);
    return Response.json({ ok: true }, { headers: noStore });
  }
  const started = await refreshSession(session);
  if (started === null) return error(404, "No Claude session there");
  return Response.json({ started }, { headers: noStore });
}
