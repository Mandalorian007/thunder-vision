import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { alive, DATA_DIR } from "../data";
import { cleanEnv, TMUX_BIN } from "../tmux";

const run = promisify(execFile);
const home = os.homedir();
const CLAUDE_DIR = path.join(/*turbopackIgnore: true*/ home, ".claude");

/** A Claude Code session running in a tmux pane. */
export type ClaudePane = {
  /** tmux pane id, like "%3": survives session renames. */
  paneId: string;
  /** The tmux session it's in, by current name. */
  session: string;
  pid: number;
  sessionId: string;
  cwd: string;
  status: string | null;
  version: string | null;
  /** The transcript file, once found. */
  transcript: string | null;
};

type Registry = {
  pid?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  tmux?: unknown;
  status?: unknown;
  version?: unknown;
};

const SEP = "\x1f";

async function listPanes() {
  try {
    const { stdout } = await run(
      TMUX_BIN,
      [
        "list-panes",
        "-a",
        "-F",
        [
          "#{session_name}",
          "#{pane_id}",
          "#{pane_active}",
          "#{window_active}",
        ].join(SEP),
      ],
      { env: cleanEnv() },
    );
    return stdout
      .split("\n")
      .map((l) => l.split(SEP))
      .filter((f) => f.length === 4)
      .map(([session, paneId, paneActive, windowActive]) => ({
        session,
        paneId,
        current: paneActive === "1" && windowActive === "1",
      }));
  } catch {
    return [];
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : null);

/**
 * Claude Code's own record of its interactive sessions:
 * ~/.claude/sessions/<pid>.json, with the tmux pane it started in. Read-only,
 * and undocumented, so every field is checked and anything odd is skipped.
 */
function readRegistry() {
  const dir = path.join(CLAUDE_DIR, "sessions");
  let files: string[];
  try {
    files = readdirSync(/*turbopackIgnore: true*/ dir).filter((f) =>
      /^\d+\.json$/.test(f),
    );
  } catch {
    return [];
  }
  const ownDir = DATA_DIR + path.sep;
  const out: Omit<ClaudePane, "session" | "transcript">[] = [];
  for (const f of files) {
    let r: Registry;
    try {
      r = JSON.parse(
        readFileSync(/*turbopackIgnore: true*/ path.join(dir, f), "utf8"),
      );
    } catch {
      continue;
    }
    const pane = /(%\d+)$/.exec(str(r.tmux) ?? "")?.[1];
    const sessionId = str(r.sessionId);
    const cwd = str(r.cwd);
    if (typeof r.pid !== "number" || !pane || !sessionId || !cwd) continue;
    // Thunder Vision's own Claude runs (overviews, questions) aren't sessions.
    if ((cwd + path.sep).startsWith(ownDir)) continue;
    if (!alive(r.pid)) continue;
    out.push({
      paneId: pane,
      pid: r.pid,
      sessionId,
      cwd,
      status: str(r.status),
      version: str(r.version),
    });
  }
  return out;
}

const found = new Map<string, string>();

/**
 * ~/.claude/projects/<cwd with every non-alphanumeric as "-">/<id>.jsonl,
 * else wherever it turns up (the session may have moved folders).
 */
export function transcriptFor(sessionId: string, cwd: string) {
  const cached = found.get(sessionId);
  if (cached && existsSync(cached)) return cached;
  const projects = path.join(CLAUDE_DIR, "projects");
  const guess = path.join(
    projects,
    cwd.replace(/[^a-zA-Z0-9]/g, "-"),
    `${sessionId}.jsonl`,
  );
  let hit: string | null = existsSync(/*turbopackIgnore: true*/ guess)
    ? guess
    : null;
  if (!hit) {
    try {
      for (const d of readdirSync(/*turbopackIgnore: true*/ projects)) {
        const f = path.join(projects, d, `${sessionId}.jsonl`);
        if (existsSync(/*turbopackIgnore: true*/ f)) {
          hit = f;
          break;
        }
      }
    } catch {}
  }
  if (hit) found.set(sessionId, hit);
  return hit;
}

/**
 * The Claude session shown for each tmux session: in its current pane if
 * Claude runs there, else the first pane that has one.
 */
export async function claudePanes(): Promise<Map<string, ClaudePane>> {
  const registry = readRegistry();
  const byPane = new Map(registry.map((r) => [r.paneId, r]));
  const out = new Map<string, ClaudePane>();
  if (!byPane.size) return out;
  const panes = await listPanes();
  // Current panes first, so they win.
  panes.sort((a, b) => Number(b.current) - Number(a.current));
  for (const p of panes) {
    const r = byPane.get(p.paneId);
    if (!r || out.has(p.session)) continue;
    out.set(p.session, {
      ...r,
      session: p.session,
      transcript: transcriptFor(r.sessionId, r.cwd),
    });
  }
  return out;
}
