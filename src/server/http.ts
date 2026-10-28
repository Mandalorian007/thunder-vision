import { originMatchesHost } from "./origin";

export const noStore = { "Cache-Control": "no-store" };

export function error(status: number, message: string, extra?: object) {
  return Response.json({ error: message, ...extra }, { status });
}

/** Mutating calls: refuse anything not sent by this app's own page. */
export function crossSite(req: Request) {
  return !originMatchesHost(
    req.headers.get("origin"),
    req.headers.get("x-forwarded-host") ?? req.headers.get("host"),
  );
}

export async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const json = await req.json();
    return json && typeof json === "object" ? json : {};
  } catch {
    return {};
  }
}
