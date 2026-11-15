/**
 * The Overview tab's data, shared by client and server. Everything here is
 * counted by scripts from the Claude transcript; no model writes any of it.
 */

/** What the script knows about a subagent's run. Not whether it succeeded. */
export type Lifecycle =
  | "running"
  | "waiting" // stopped, but its own background work is still going
  | "completed"
  | "failed"
  | "stopped"
  | "killed";

export type AgentFact = {
  /** The Agent tool_use id: stable from the moment it's spawned. */
  toolUseId: string;
  agentId: string | null;
  description: string;
  type: string | null;
  model: string | null;
  background: boolean;
  spawnedAt: string;
  endedAt: string | null;
  lifecycle: Lifecycle;
  /** Sent its final report back (a hand-back), as of endedAt. */
  handedBack: boolean;
  /** Spawned by another subagent, not by this session. */
  nested: boolean;
  tokens: number | null;
  toolUses: number | null;
  durationMs: number | null;
  /** The transcript uuid of the spawn, for citing. */
  uuid: string;
};

export type EventKind =
  | "human" // you typed it
  | "spawn"
  | "handback"
  | "agent-end"
  | "message" // the session messaged a running agent
  | "pr"
  | "release" // merge, tag, publish
  | "commit"
  | "compact"
  | "error";

export type OverviewEvent = {
  uuid: string;
  at: string;
  kind: EventKind;
  text: string;
  /** The agent it's about, shown in bold before the text. */
  who?: string;
  /** The full message as markdown, when `text` is only its first line. */
  detail?: string;
  /** Counts toward the "new" badge. */
  weight: 0 | 1;
  /** Something went wrong: shown red. */
  alert?: boolean;
};

export type SessionKind = "program" | "generic";

export type Facts = {
  paneId: string;
  sessionId: string;
  title: string | null;
  cwd: string;
  branch: string | null;
  version: string | null;
  /** From Claude's own session file: busy | idle | shell (waiting on a tool). */
  status: string | null;
  kind: SessionKind;
  startedAt: string | null;
  lastActivity: string | null;
  /** Background agents Claude reported still pending at the end of its last turn. */
  pendingBackground: number | null;
  counts: {
    human: number;
    spawns: number;
    handbacks: number;
    messages: number;
    prs: number;
    releases: number;
    commits: number;
    compactions: number;
  };
  agents: AgentFact[];
  prs: { number: string; url: string; repo: string; at: string }[];
  /** Newest last. */
  events: OverviewEvent[];
  /** When you last opened the Overview; events after it are "new". */
  seenAt: string | null;
  generatedAt: string;
};

/** Rides along on the 2s session poll, per tmux session. */
export type OverviewBadge = {
  /** A Claude session runs in one of this tmux session's panes. */
  claude: true;
  newEvents: number;
  alerts: number;
  agentsRunning: number;
  status: string | null;
};

// ── The Haiku summary ─────────────────────────────────────────────────────

/** A transcript line the model pointed to, kept so you can check its claim. */
export type Cite = { uuid: string; at: string; who: string; text: string };

export type AreaState = "done" | "on-track" | "at-risk" | "blocked" | "idle";

export type SummaryItem = { text: string; cites: Cite[] };

export type Summary = {
  goal: string;
  headline: string;
  areas: {
    name: string;
    state: AreaState;
    /** Only when the session itself reported counts for the area. */
    done: number | null;
    total: number | null;
    summary: string;
    now: string;
    next: string;
    cites: Cite[];
  }[];
  decisions: {
    decision: string;
    why: string;
    by: "pm" | "you";
    cites: Cite[];
  }[];
  needsYou: SummaryItem[];
  recent: SummaryItem[];
  next: SummaryItem[];
};

/** Minutes between scheduled refreshes; 0 is manual. */
export const EVERY_CHOICES = [0, 15, 30, 60, 360] as const;

export type SummaryState = {
  summary: Summary | null;
  generatedAt: string | null;
  model: string | null;
  costUsd: number | null;
  /** Transcript lines it read. */
  lines: number;
  running: boolean;
  /** The last attempt failed; the summary shown is the one before. */
  error: { at: string; message: string } | null;
  failures: number;
  /** Scheduled refreshes stop after repeated failures, until a manual one. */
  paused: boolean;
  every: number;
};
