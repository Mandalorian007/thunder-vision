import type { OverviewBadge } from "@/lib/overview";
import type { TmuxSession } from "../tmux";
import { badgeFor, factsFor, markSeen } from "./facts";
import { claudePanes } from "./resolve";

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
