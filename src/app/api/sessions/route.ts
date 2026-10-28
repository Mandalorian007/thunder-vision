import { toSessionName } from "@/lib/names";
import { originMatchesHost } from "@/server/origin";
import {
  prepareDir,
  sessionNameFor,
  SetupError,
  toAbsolute,
} from "@/server/repos";
import {
  hasSession,
  killSession,
  listSessions,
  newSession,
  renameSession,
} from "@/server/tmux";

const noStore = { "Cache-Control": "no-store" };

function error(status: number, message: string, extra?: object) {
  return Response.json({ error: message, ...extra }, { status });
}

const clash = (name: string) =>
  error(409, `Session ${name} already exists`, { name });

/** These change tmux state, so refuse anything not sent by this app's page. */
function crossSite(req: Request) {
  return !originMatchesHost(
    req.headers.get("origin"),
    req.headers.get("x-forwarded-host") ?? req.headers.get("host"),
  );
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const json = await req.json();
    return json && typeof json === "object" ? json : {};
  } catch {
    return {};
  }
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export async function GET() {
  return Response.json(await listSessions(), { headers: noStore });
}

/**
 * { dir, create?, git?, clone?, name?, command? } → new detached session.
 * `dir` is relative to TV_ROOT, or "~/…" / "/…". `clone` is a git URL to
 * clone into `dir` first; `command` is typed into the new shell.
 */
export async function POST(req: Request) {
  if (crossSite(req)) return error(403, "cross-site request");
  const input = await body(req);
  if (typeof input.dir !== "string") return error(400, "dir is required");

  const abs = toAbsolute(input.dir);
  const name = toSessionName(str(input.name)) || sessionNameFor(abs);
  // Before touching the disk, so a clash doesn't leave a fresh folder behind.
  if (await hasSession(name)) return clash(name);

  try {
    await prepareDir(abs, {
      create: input.create === true,
      git: input.git === true,
      clone: str(input.clone) || undefined,
    });
    await newSession(name, abs, str(input.command) || undefined);
  } catch (err) {
    if (err instanceof SetupError) return error(400, err.message);
    const stderr = (err as { stderr?: string }).stderr ?? "";
    if (/duplicate session/.test(stderr)) return clash(name);
    throw err;
  }
  return Response.json(
    { name, sessions: await listSessions() },
    { status: 201, headers: noStore },
  );
}

/** { name, to } → rename-session. */
export async function PATCH(req: Request) {
  if (crossSite(req)) return error(403, "cross-site request");
  const input = await body(req);
  const from = str(input.name);
  const to = toSessionName(str(input.to));
  if (!to) return error(400, "New name is required");
  if (!(await hasSession(from))) return error(404, "No such session");
  if (to !== from) {
    if (await hasSession(to)) return clash(to);
    await renameSession(from, to);
  }
  return Response.json(
    { name: to, sessions: await listSessions() },
    { headers: noStore },
  );
}

/** { name } → kill-session. */
export async function DELETE(req: Request) {
  if (crossSite(req)) return error(403, "cross-site request");
  const { name } = await body(req);
  if (typeof name !== "string" || !(await hasSession(name))) {
    return error(404, "No such session");
  }
  await killSession(name);
  return Response.json(
    { sessions: await listSessions() },
    { headers: noStore },
  );
}
