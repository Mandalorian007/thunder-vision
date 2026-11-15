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
