import { mkdirSync, readdirSync, statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import type {
  AgentFact,
  Facts,
  Lifecycle,
  OverviewBadge,
  OverviewEvent,
} from "@/lib/overview";
import { DATA_DIR, readJson, writeJson } from "../data";
import type { ClaudePane } from "./resolve";

/**
 * Facts about a Claude session, read incrementally from its transcript: a
 * byte cursor per file, so after the first read only new lines are parsed.
 * Never reads subagent transcripts, only their small .meta.json files.
 */

export const OVERVIEW_DIR = path.join(DATA_DIR, "overview");

const MAX_EVENTS = 400;
const CHUNK = 4 << 20;
const META_EVERY_MS = 15_000;
const MIN_UPDATE_MS = 1_500;
const TEXT = 280;
const GIST = 180;
const DETAIL = 2_500;

/** Bumped when parsing changes, so saved state is re-read from the top. */
const STATE_V = 2;

type State = {
  v: number;
  sessionId: string;
  transcript: string;
  cursor: number;
  facts: Facts;
  /** Task notifications already counted: task id + status. */
  notified: string[];
};

type Live = {
  state: State | null;
  /** Bytes after the last newline read: a line still being written. */
  partial: Buffer;
  /** Bash calls worth reporting, until their result arrives. */
  bash: Map<string, { kind: "release" | "commit"; text: string }>;
  updating: Promise<void> | null;
  updatedAt: number;
  metaAt: number;
};

// One cache per process: route handlers and server.ts can each load their
// own copy of this module.
const g = globalThis as { __tvOverview?: Map<string, Live> };
const live: Map<string, Live> = (g.__tvOverview ??= new Map());

export function paneDir(paneId: string) {
  return path.join(OVERVIEW_DIR, `pane-${paneId.replace(/\D/g, "")}`);
}

/** Holds copies of transcript text: private to you. */
function ensureDir(paneId: string) {
  const dir = paneDir(paneId);
  mkdirSync(/*turbopackIgnore: true*/ dir, { recursive: true, mode: 0o700 });
  return dir;
}

const clip = (s: string, n = TEXT) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Markdown kept for the expanded view: newlines intact, length capped. */
const block = (s: string, n = DETAIL) => {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/**
 * The gist of a markdown message for a one-line row: its first paragraph
 * that isn't a heading, with the markup stripped, cut at a word.
 */
function gist(md: string, n = GIST) {
  const paras = md
    .split(/\n\s*\n|\n(?=#{1,6}\s|[-*]\s|\d+\.\s)/)
    .map((p) => p.trim())
    .filter(Boolean);
  const para =
    paras.find((p) => !/^#{1,6}\s/.test(p) && !/^[-*_]{3,}$/.test(p)) ??
    paras[0] ??
    "";
  const plain = para
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*]|\d+\.)\s+/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|`)(.+?)\1/g, "$2")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= n) return plain;
  const cut = plain.slice(0, n);
  const sentence = cut.search(/[.!?](?=\s)[^.!?]*$/);
  if (sentence > n * 0.5) return cut.slice(0, sentence + 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > n * 0.6 ? cut.lastIndexOf(" ") : n - 1).trimEnd()}…`;
}

/** text + detail for a markdown message: detail only when text loses some. */
function summarize(md: string) {
  const text = gist(md);
  const full = md.replace(/\s+/g, " ").trim();
  return full === text ? { text } : { text, detail: block(md) };
}

function freshFacts(pane: ClaudePane): Facts {
  return {
    paneId: pane.paneId,
    sessionId: pane.sessionId,
    title: null,
    cwd: pane.cwd,
    branch: null,
    version: pane.version,
    status: pane.status,
    kind: "generic",
    startedAt: null,
    lastActivity: null,
    pendingBackground: null,
    counts: {
      human: 0,
      spawns: 0,
      handbacks: 0,
      messages: 0,
      prs: 0,
      releases: 0,
      commits: 0,
      compactions: 0,
    },
    agents: [],
    prs: [],
    events: [],
    seenAt: null,
    generatedAt: new Date().toISOString(),
  };
}

// ── Reading entries ───────────────────────────────────────────────────────

export type Entry = Record<string, unknown>;
export type Block = Record<string, unknown>;

export const s = (v: unknown) => (typeof v === "string" ? v : "");
export const obj = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Entry) : null;
export const num = (v: unknown) => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

export function contentOf(e: Entry): { text: string; blocks: Block[] } {
  const c = obj(e.message)?.content;
  if (typeof c === "string") return { text: c, blocks: [] };
  if (!Array.isArray(c)) return { text: "", blocks: [] };
  const blocks = c.filter((b): b is Block => !!obj(b));
  const text = blocks
    .filter((b) => b.type === "text")
    .map((b) => s(b.text))
    .join("\n");
  return { text, blocks };
}

export const tag = (text: string, name: string) =>
  new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim() ?? "";

/** What you typed, minus Claude Code's wrappers around slash commands. */
export function humanText(text: string) {
  const cmd = tag(text, "command-name");
  if (cmd) return `${cmd} ${tag(text, "command-args")}`.trim();
  if (/^<(local-command|bash-|system-reminder)/.test(text.trim())) return "";
  return text;
}

export const RELEASE =
  /\bgh pr merge\b|\bmerge-pr\b|\b(?:npm|pnpm|cargo) publish\b|\bgit tag\b/;
export const COMMIT = /\bgit commit\b/;

/** 'Agent "X" completed' → "completed", when the row already names X. */
function agentNote(summary: string, name: string | undefined) {
  if (!name) return summary;
  const q = `"${name}"`;
  const i = summary.indexOf(q);
  if (i < 0) return summary;
  const rest = summary.slice(i + q.length).trim();
  return rest ? rest[0].toUpperCase() + rest.slice(1) : summary;
}

function lifecycleOf(status: string, note: string): Lifecycle | null {
  if (status === "completed") {
    return /background work/i.test(note) ? "waiting" : "completed";
  }
  if (status === "failed" || status === "killed" || status === "stopped") {
    return status;
  }
  return null;
}

class Reader {
  constructor(
    private st: State,
    private l: Live,
  ) {}

  private get f() {
    return this.st.facts;
  }

  private agentByTool(id: string) {
    return this.f.agents.find((a) => a.toolUseId === id);
  }

  private agentById(id: string) {
    return this.f.agents.find((a) => a.agentId === id);
  }

  private event(e: OverviewEvent) {
    this.f.events.push(e);
  }

  apply(e: Entry) {
    const at = s(e.timestamp);
    const uuid = s(e.uuid);
    const f = this.f;
    if (at) {
      f.startedAt ??= at;
      if (!f.lastActivity || at > f.lastActivity) f.lastActivity = at;
    }
    if (s(e.gitBranch)) f.branch = s(e.gitBranch);
    if (s(e.version)) f.version = s(e.version);

    switch (e.type) {
      case "ai-title":
        if (s(e.aiTitle)) f.title = s(e.aiTitle);
        return;
      case "pr-link":
        return this.prLink(e, at);
      case "system":
        if (e.subtype === "compact_boundary") {
          const m = obj(e.compactMetadata);
          f.counts.compactions++;
          this.event({
            uuid,
            at,
            kind: "compact",
            weight: 1,
            text: `Compacted (${s(m?.trigger) || "auto"})`,
          });
        } else if (e.subtype === "turn_duration") {
          f.pendingBackground = num(e.pendingBackgroundAgentCount);
        }
        return;
      case "user":
        return this.user(e, at, uuid);
      case "assistant":
        return this.assistant(e, at, uuid);
    }
  }

  private prLink(e: Entry, at: string) {
    const number = String(num(e.prNumber) ?? s(e.prNumber));
    const repo = s(e.prRepository);
    if (
      !number ||
      this.f.prs.some((p) => p.number === number && p.repo === repo)
    )
      return;
    this.f.prs.push({ number, repo, url: s(e.prUrl), at });
    this.f.counts.prs++;
    this.event({
      uuid: `pr:${repo}#${number}`,
      at,
      kind: "pr",
      weight: 1,
      text: `PR #${number}${repo ? ` · ${repo.split("/").pop()}` : ""}`,
    });
  }

  private user(e: Entry, at: string, uuid: string) {
    if (e.isCompactSummary) return;
    const origin = obj(e.origin);
    const { text, blocks } = contentOf(e);
    const kind = s(origin?.kind);

    if (kind === "task-notification") return this.notification(text, at, uuid);
    if (kind === "peer") {
      const from = s(origin?.from);
      const body = s(origin?.body) || text;
      const handBack = /\[Subagent hand-back\]/.test(body);
      const agent = from ? this.agentById(from) : undefined;
      if (handBack) {
        this.f.counts.handbacks++;
        if (agent) {
          agent.handedBack = true;
          agent.endedAt = at;
          if (agent.lifecycle === "running" || agent.lifecycle === "waiting")
            agent.lifecycle = "completed";
        }
      }
      const report = body
        .replace(/^[\s\S]*?\[Subagent hand-back\][^\n]*\n?/, "")
        .replace(/<\/?agent-message[^>]*>/g, "");
      this.event({
        uuid,
        at,
        kind: "handback",
        weight: 1,
        who: agent?.description ?? (s(origin?.name) || "Agent"),
        ...summarize(report),
      });
      return;
    }
    if (
      kind === "human" ||
      (!kind && typeof obj(e.message)?.content === "string")
    ) {
      const said = humanText(text);
      if (!said || e.isMeta) return;
      this.f.counts.human++;
      const long = said.trim().length > 600;
      this.event({
        uuid,
        at,
        kind: "human",
        weight: 0,
        text: clip(said, 600),
        ...(long ? { detail: block(said) } : {}),
      });
      return;
    }

    // Tool results.
    const result = obj(e.toolUseResult);
    for (const b of blocks) {
      if (b.type !== "tool_result") continue;
      const id = s(b.tool_use_id);
      const agent = this.agentByTool(id);
      if (agent && result) {
        if (s(result.agentId)) agent.agentId = s(result.agentId);
        if (result.isAsync === true) agent.background = true;
        else if (s(result.status) === "completed") {
          agent.lifecycle = "completed";
          agent.endedAt = at;
          agent.tokens = num(result.totalTokens) ?? agent.tokens;
          agent.durationMs = num(result.totalDurationMs) ?? agent.durationMs;
        }
      }
      const bash = this.l.bash.get(id);
      if (bash) {
        this.l.bash.delete(id);
        const failed = b.is_error === true;
        if (!failed)
          this.f.counts[bash.kind === "release" ? "releases" : "commits"]++;
        this.event({
          uuid,
          at,
          kind: failed ? "error" : bash.kind,
          weight: failed || bash.kind === "release" ? 1 : 0,
          alert: failed || undefined,
          text: failed ? `Failed: ${bash.text}` : bash.text,
        });
      }
    }
  }

  private notification(text: string, at: string, uuid: string) {
    const taskId = tag(text, "task-id");
    const status = tag(text, "status");
    const note = tag(text, "note");
    const lifecycle = lifecycleOf(status, note);
    const key = `${taskId}:${lifecycle}`;
    if (!taskId || !lifecycle || this.st.notified.includes(key)) return;
    this.st.notified.push(key);
    const agent =
      this.agentByTool(tag(text, "tool-use-id")) ?? this.agentById(taskId);
    if (agent) {
      agent.agentId ??= taskId;
      // A hand-back already said it's done; a late "waiting" doesn't undo that.
      if (!(agent.handedBack && lifecycle === "waiting")) {
        agent.lifecycle = lifecycle;
        agent.endedAt = at;
      }
      agent.tokens = num(tag(text, "subagent_tokens")) ?? agent.tokens;
      agent.toolUses = num(tag(text, "tool_uses")) ?? agent.toolUses;
      agent.durationMs = num(tag(text, "duration_ms")) ?? agent.durationMs;
    }
    const bad = lifecycle === "failed" || lifecycle === "killed";
    this.event({
      uuid,
      at,
      kind: bad ? "error" : "agent-end",
      weight: lifecycle === "waiting" ? 0 : 1,
      alert: bad || undefined,
      who: agent?.description,
      text: clip(
        agentNote(tag(text, "summary"), agent?.description) ||
          `${agent ? "" : `${taskId} `}${lifecycle}`,
      ),
    });
  }

  private assistant(e: Entry, at: string, uuid: string) {
    for (const b of contentOf(e).blocks) {
      if (b.type !== "tool_use") continue;
      const input = obj(b.input) ?? {};
      const id = s(b.id);
      switch (b.name) {
        case "Agent":
        case "Task": {
          if (this.agentByTool(id)) break;
          const description = s(input.description) || "Agent";
          const agent: AgentFact = {
            toolUseId: id,
            agentId: null,
            description,
            type: s(input.subagent_type) || null,
            model: s(input.model) || null,
            background: input.run_in_background === true,
            spawnedAt: at,
            endedAt: null,
            lifecycle: "running",
            handedBack: false,
            nested: false,
            tokens: null,
            toolUses: null,
            durationMs: null,
            uuid,
          };
          this.f.agents.push(agent);
          this.f.counts.spawns++;
          this.event({
            uuid,
            at,
            kind: "spawn",
            weight: 1,
            who: description,
            text: [
              "Started",
              agent.type && agent.type !== "general-purpose" ? agent.type : "",
              agent.background ? "in the background" : "",
            ]
              .filter(Boolean)
              .join(" · "),
          });
          break;
        }
        case "SendMessage": {
          this.f.counts.messages++;
          const to = s(input.to);
          const who = this.agentById(to)?.description ?? to;
          this.event({
            uuid,
            at,
            kind: "message",
            weight: 0,
            who: `→ ${who}`,
            ...(s(input.summary)
              ? {
                  text: gist(s(input.summary)),
                  detail: block(s(input.message)) || undefined,
                }
              : summarize(s(input.message))),
          });
          break;
        }
        case "Bash": {
          const cmd = s(input.command);
          const kind = RELEASE.test(cmd)
            ? "release"
            : COMMIT.test(cmd)
              ? "commit"
              : null;
          if (kind) {
            this.l.bash.set(id, {
              kind,
              text: clip(s(input.description) || cmd, 160),
            });
          }
          break;
        }
      }
    }
  }

  /** Subagents' own .meta.json: nested agents and finished flags. */
  meta() {
    const dir = this.st.transcript.replace(/\.jsonl$/, "") + "/subagents";
    let names: string[];
    try {
      names = readdirSync(/*turbopackIgnore: true*/ dir).filter((n) =>
        n.endsWith(".meta.json"),
      );
    } catch {
      return;
    }
    for (const name of names) {
      const agentId = name.slice("agent-".length, -".meta.json".length);
      const file = path.join(dir, name);
      const m = readJson<Entry>(file);
      if (!m) continue;
      const toolUseId = s(m.toolUseId);
      const existing =
        (toolUseId && this.agentByTool(toolUseId)) || this.agentById(agentId);
      const log = statSync(
        /*turbopackIgnore: true*/ file.replace(/\.meta\.json$/, ".jsonl"),
        { throwIfNoEntry: false },
      );
      const lastWrite = log ? log.mtime.toISOString() : null;
      if (existing) {
        existing.agentId ??= agentId;
        if (m.finished === true && existing.lifecycle === "running") {
          existing.lifecycle = "completed";
          existing.endedAt ??= lastWrite;
        }
        continue;
      }
      // Not spawned by this session: one of its agents' own agents.
      const born = statSync(/*turbopackIgnore: true*/ file, {
        throwIfNoEntry: false,
      });
      this.f.agents.push({
        toolUseId: toolUseId || `meta:${agentId}`,
        agentId,
        description: s(m.description) || "Agent",
        type: s(m.agentType) || null,
        model: s(m.pickedEffortModel) || s(m.model) || null,
        background: s(m.requestShape) === "background",
        spawnedAt: born?.birthtime.toISOString() ?? lastWrite ?? "",
        endedAt: m.finished === true ? lastWrite : null,
        lifecycle: m.finished === true ? "completed" : "running",
        handedBack: false,
        nested: true,
        tokens: null,
        toolUses: null,
        durationMs: null,
        uuid: "",
      });
    }
  }
}

// ── Updating ──────────────────────────────────────────────────────────────

function load(pane: ClaudePane): State | null {
  const st = readJson<State>(path.join(paneDir(pane.paneId), "state.json"));
  if (!st || st.v !== STATE_V || st.sessionId !== pane.sessionId) return null;
  if (!st.facts) return null;
  return st;
}

function seenAtOf(paneId: string) {
  return (
    readJson<{ seenAt?: string }>(path.join(paneDir(paneId), "seen.json"))
      ?.seenAt ?? null
  );
}

/** Opening the Overview: what's there now is no longer new. */
export function markSeen(paneId: string) {
  const at = new Date().toISOString();
  ensureDir(paneId);
  writeJson(path.join(paneDir(paneId), "seen.json"), { seenAt: at });
  const l = live.get(paneId);
  if (l?.state) l.state.facts.seenAt = at;
}

async function readNew(st: State, l: Live, reader: Reader) {
  const info = await stat(/*turbopackIgnore: true*/ st.transcript).catch(
    () => null,
  );
  if (!info) return false;
  if (info.size < st.cursor) {
    // Rewritten from scratch: start over.
    return null;
  }
  if (info.size === st.cursor) return false;
  const fh = await open(/*turbopackIgnore: true*/ st.transcript, "r");
  try {
    const buf = Buffer.alloc(CHUNK);
    while (st.cursor < info.size) {
      const { bytesRead } = await fh.read(
        buf,
        0,
        Math.min(CHUNK, info.size - st.cursor),
        st.cursor,
      );
      if (!bytesRead) break;
      st.cursor += bytesRead;
      // Split on newline bytes, so a character cut at the chunk edge stays whole.
      const data = Buffer.concat([l.partial, buf.subarray(0, bytesRead)]);
      const end = data.lastIndexOf(0x0a);
      l.partial = Buffer.from(data.subarray(end + 1));
      if (end < 0) continue;
      for (const line of data.toString("utf8", 0, end).split("\n")) {
        if (!line || line.includes('"type":"api-request')) continue;
        try {
          reader.apply(JSON.parse(line));
        } catch {}
      }
    }
  } finally {
    await fh.close();
  }
  return true;
}

async function update(pane: ClaudePane, l: Live) {
  if (!pane.transcript) return;
  if (
    !l.state ||
    l.state.v !== STATE_V ||
    l.state.sessionId !== pane.sessionId
  ) {
    l.state = load(pane) ?? fresh(pane, pane.transcript);
    l.partial = Buffer.alloc(0);
    l.bash.clear();
    l.metaAt = 0;
  }
  const st = l.state;
  st.transcript = pane.transcript;
  // Nothing before the first look counts as new.
  if (!seenAtOf(pane.paneId)) markSeen(pane.paneId);
  st.facts.seenAt = seenAtOf(pane.paneId);
  st.facts.status = pane.status;
  st.facts.cwd = pane.cwd;

  const reader = new Reader(st, l);
  let changed = await readNew(st, l, reader);
  if (changed === null) {
    // The transcript shrank: start over from its first byte, not from the
    // saved state, which has the same too-large cursor.
    l.state = fresh(pane, pane.transcript);
    l.partial = Buffer.alloc(0);
    l.bash.clear();
    l.metaAt = 0;
    return update(pane, l);
  }
  if (Date.now() - l.metaAt > META_EVERY_MS) {
    l.metaAt = Date.now();
    reader.meta();
    changed = true;
  }
  if (!changed) return;
  const f = st.facts;
  if (f.events.length > MAX_EVENTS)
    f.events.splice(0, f.events.length - MAX_EVENTS);
  if (st.notified.length > 4000)
    st.notified.splice(0, st.notified.length - 4000);
  if (f.counts.spawns >= 3 || f.counts.messages >= 3) f.kind = "program";
  f.generatedAt = new Date().toISOString();
  // Saved before the unfinished line, so a restart reads it again whole.
  writeJson(path.join(ensureDir(pane.paneId), "state.json"), {
    ...st,
    cursor: st.cursor - l.partial.length,
  });
}

function fresh(pane: ClaudePane, transcript: string): State {
  return {
    v: STATE_V,
    sessionId: pane.sessionId,
    transcript,
    cursor: 0,
    facts: freshFacts(pane),
    notified: [],
  };
}

function liveFor(paneId: string) {
  let l = live.get(paneId);
  if (!l) {
    l = {
      state: null,
      partial: Buffer.alloc(0),
      bash: new Map(),
      updating: null,
      updatedAt: 0,
      metaAt: 0,
    };
    live.set(paneId, l);
  }
  return l;
}

function refresh(pane: ClaudePane, l: Live) {
  if (l.updating) return l.updating;
  if (Date.now() - l.updatedAt < MIN_UPDATE_MS && l.state)
    return Promise.resolve();
  l.updating = update(pane, l)
    .catch((err) => console.error("[overview] update failed:", err))
    .finally(() => {
      l.updating = null;
      l.updatedAt = Date.now();
    });
  return l.updating;
}

/** Up-to-date facts for one pane. */
export async function factsFor(pane: ClaudePane): Promise<Facts | null> {
  const l = liveFor(pane.paneId);
  await refresh(pane, l);
  return l.state?.facts ?? null;
}

/**
 * Badges from what's already known, without waiting: the update runs in the
 * background, so a long first read never slows the session poll.
 */
export function badgeFor(pane: ClaudePane): OverviewBadge {
  const l = liveFor(pane.paneId);
  void refresh(pane, l);
  const f = l.state?.facts;
  const seen = f?.seenAt ?? "";
  let newEvents = 0;
  for (const e of f?.events ?? []) if (e.at > seen) newEvents += e.weight;
  return {
    claude: true,
    newEvents,
    agentsRunning:
      f?.agents.filter((a) => a.lifecycle === "running").length ?? 0,
    status: pane.status,
  };
}
