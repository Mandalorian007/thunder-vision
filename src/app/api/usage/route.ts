import { originMatchesHost } from "@/server/origin";
import { getUsage } from "@/server/usage";

const noStore = { "Cache-Control": "no-store" };

/** Plan usage, as /usage shows it; null when unavailable. */
export async function GET() {
  return Response.json(await getUsage(), { headers: noStore });
}

/**
 * The refresh button: checks now rather than at the hourly mark. Starts
 * Claude Code, so only this app's page may ask.
 */
export async function POST(req: Request) {
  const sameOrigin = originMatchesHost(
    req.headers.get("origin"),
    req.headers.get("x-forwarded-host") ?? req.headers.get("host"),
  );
  if (!sameOrigin) {
    return Response.json({ error: "bad origin" }, { status: 403 });
  }
  return Response.json(await getUsage(true), { headers: noStore });
}
