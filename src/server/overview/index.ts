import { execFile } from "node:child_process";
import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { EVERY_CHOICES, type OverviewBadge } from "@/lib/overview";
import { cleanEnv, TMUX_BIN, type TmuxSession } from "../tmux";
import { badgeFor, factsFor, markSeen, OVERVIEW_DIR } from "./facts";
import { claudePanes } from "./resolve";
import {
  lastAttempt,
  MAX_FAILURES,
  refreshSummary,
  RETRY_MS,
  summaryState,
} from "./summary";

const run = promisify(execFile);

const SWEEP_EVERY_MS = 60 * 60_000;
/** A pane's folder outlives its Claude session by this long. */
const KEEP_MS = 7 * 86_400_000;
let lastSweep = 0;

/** Removes overview folders of panes gone for a week. */
function sweep(live: Set<string>) {
  let dirs: string[];
  try {
    dirs = readdirSync(/*turbopackIgnore: true*/ OVERVIEW_DIR);
  } catch {
    return;
  }
  for (const d of dirs) {
    if (!/^pane-\d+$/.test(d) || live.has(`%${d.slice(5)}`)) continue;
    const dir = path.join(OVERVIEW_DIR, d);
    try {
      if (
        Date.now() - statSync(/*turbopackIgnore: true*/ dir).mtimeMs <
        KEEP_MS
      )
        continue;
      rmSync(/*turbopackIgnore: true*/ dir, { recursive: true, force: true });
    } catch {}
  }
}

export type { ClaudePane } from "./resolve";

/** Adds Overview badges to sessions that have Claude running in them. */
export async function withBadges(
  sessions: TmuxSession[],
): Promise<TmuxSession[]> {
  let panes;
  try {
    panes = await claudePanes();
  } catch (err) {
    console.error("[overview] couldn't find Claude sessions:", err);
    return sessions;
  }
  return sessions.map((s) => {
    const pane = panes.get(s.name);
    if (!pane) return s;
    let overview: OverviewBadge;
    try {
      overview = badgeFor(pane);
    } catch {
      return s;
    }
    return { ...s, overview };
  });
}

export async function factsForSession(name: string) {
  const pane = (await claudePanes()).get(name);
  return pane ? { pane, facts: await factsFor(pane) } : null;
}

export async function markSessionSeen(name: string) {
  const pane = (await claudePanes()).get(name);
  if (pane) markSeen(pane.paneId);
  return !!pane;
}

// ── Summary ───────────────────────────────────────────────────────────────

/** The refresh interval, kept on the tmux session like the sidebar order. */
const EVERY_OPTION = "@tv_overview_every";

async function everyBySession(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const { stdout } = await run(
      TMUX_BIN,
      ["list-sessions", "-F", `#{session_name}\x1f#{${EVERY_OPTION}}`],
      { env: cleanEnv() },
    );
    for (const line of stdout.split("\n")) {
      const [name, every] = line.split("\x1f");
      const n = Number(every);
      if (name && (EVERY_CHOICES as readonly number[]).includes(n) && n > 0) {
        out.set(name, n);
      }
    }
  } catch {}
  return out;
}

export async function setEvery(name: string, every: number) {
  const args =
    every > 0
      ? ["set-option", "-t", `=${name}:`, EVERY_OPTION, String(every)]
      : ["set-option", "-u", "-t", `=${name}:`, EVERY_OPTION];
  await run(TMUX_BIN, args, { env: cleanEnv() });
}

export async function overviewForSession(name: string) {
  const pane = (await claudePanes()).get(name);
  if (!pane) return null;
  const every = (await everyBySession()).get(name) ?? 0;
  return {
    pane,
    facts: await factsFor(pane),
    summary: summaryState(pane, every),
  };
}

/** Starts a summary now; false if one is already running. */
export async function refreshSession(name: string) {
  const pane = (await claudePanes()).get(name);
  if (!pane) return null;
  if (!pane.transcript || summaryState(pane, 0).running) return false;
  // Not awaited: it takes ~30s. The page polls for the result.
  refreshSummary(pane).catch((err) =>
    console.error("[overview] summary failed:", err),
  );
  return true;
}

/**
 * From the scheduler tick: refreshes sessions whose interval is up, if
 * anything worth reading happened since. A failure is retried after
 * RETRY_MS; after MAX_FAILURES in a row the schedule waits for a manual
 * refresh.
 */
export async function overviewTick() {
  if (Date.now() - lastSweep > SWEEP_EVERY_MS) {
    lastSweep = Date.now();
    sweep(new Set([...(await claudePanes()).values()].map((p) => p.paneId)));
  }
  const every = await everyBySession();
  if (!every.size) return;
  const panes = await claudePanes();
  const now = Date.now();
  for (const [name, minutes] of every) {
    const pane = panes.get(name);
    if (!pane) continue;
    const last = lastAttempt(pane);
    if (last.failures >= MAX_FAILURES) continue;
    const since = last.generatedAt ? Date.parse(last.generatedAt) : 0;
    if (last.failures > 0) {
      if (now - Date.parse(last.failedAt ?? "") < RETRY_MS) continue;
    } else if (now - since < minutes * 60_000) continue;
    const facts = await factsFor(pane);
    const fresh = facts?.events.some(
      (e) => e.weight > 0 && Date.parse(e.at) > since,
    );
    if (!fresh) continue;
    await refreshSummary(pane);
  }
}
