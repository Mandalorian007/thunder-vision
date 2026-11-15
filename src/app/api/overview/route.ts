import type { NextRequest } from "next/server";
import { body, crossSite, error, noStore } from "@/server/http";
import { markSessionSeen, overviewForSession } from "@/server/overview";

/**
 * ?session=name → the facts counted from its Claude transcript, and the
 * last Haiku summary with its refresh state.
 */
export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("session") ?? "";
  const found = await overviewForSession(name);
  if (!found) return error(404, "No Claude session there");
  return Response.json(
    { facts: found.facts, summary: found.summary },
    { headers: noStore },
  );
}

/** { session } → marks what's there now as seen, clearing the badge. */
export async function POST(req: Request) {
  if (crossSite(req)) return error(403, "cross-site request");
  const { session } = await body(req);
  if (typeof session !== "string" || !(await markSessionSeen(session))) {
    return error(404, "No Claude session there");
  }
  return Response.json({ ok: true }, { headers: noStore });
}
