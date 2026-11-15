import { readFile } from "node:fs/promises";
import {
  COMMIT,
  contentOf,
  humanText,
  obj,
  RELEASE,
  s,
  tag,
  type Entry,
} from "./facts";

/**
 * What Haiku reads: the session's transcript cut down to who said what, which
 * agents were started, told, and reported back, and what shipped. Each line
 * gets a short id (e12) that the model cites; the ids map back to transcript
 * uuids. Tool output, file contents and fetched pages are never included.
 */

/** Newest lines kept, in characters (about 4 per token). */
const RECENT_CHARS = 140_000;
/** The newest compaction summary: the session's own account of the plan. */
const ANCHOR_CHARS = 24_000;

export type Digest = {
  text: string;
  /** The lines given ids, for resolving the model's cites. */
  entries: (Line & { id: string })[];
  /** Lines in the digest; 0 means nothing to summarize. */
  lines: number;
};

export type Line = { uuid: string; at: string; who: string; text: string };

const squash = (t: string) => t.replace(/[ \t]+/g, " ").trim();

/** Head and tail of a long text, so both the ask and the conclusion survive. */
function ends(t: string, head: number, tail = 0) {
  const x = squash(t);
  if (x.length <= head + tail + 20) return x;
  return tail
    ? `${x.slice(0, head)} […] ${x.slice(-tail)}`
    : `${x.slice(0, head)}…`;
}

const pad = (n: number) => String(n).padStart(2, "0");

function hhmm(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${d.toTimeString().slice(0, 5)}`;
}

export async function buildDigest(transcript: string): Promise<Digest> {
  const raw = await readFile(/*turbopackIgnore: true*/ transcript, "utf8");
  const lines: Line[] = [];
  let anchor = "";
  const names = new Map<string, string>(); // agentId → description
  const byTool = new Map<string, string>(); // tool_use id → description
  const bash = new Map<string, string>(); // tool_use id → description

  const rows = raw.split("\n");
  for (let i = 0; i < rows.length; i++) {
    // Long transcripts: let terminals and requests through now and then.
    if (i % 2000 === 1999) await new Promise((r) => setImmediate(r));
    const l = rows[i];
    if (!l || l.includes('"type":"api-request')) continue;
    let e: Entry;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    const uuid = s(e.uuid);
    const at = s(e.timestamp);
    const push = (who: string, text: string) => {
      if (text) lines.push({ uuid, at, who, text });
    };

    if (e.type === "system" && e.subtype === "compact_boundary") {
      push("SYSTEM", "Context compacted; earlier detail is summarized.");
      continue;
    }
    if (e.type === "user") {
      const { text, blocks } = contentOf(e);
      if (e.isCompactSummary) {
        anchor = text;
        continue;
      }
      const origin = obj(e.origin);
      const kind = s(origin?.kind);
      if (kind === "task-notification") {
        const who =
          byTool.get(tag(text, "tool-use-id")) ?? tag(text, "task-id");
        push(
          "NOTICE",
          ends(`${who}: ${tag(text, "status")}. ${tag(text, "summary")}`, 240),
        );
        continue;
      }
      if (kind === "peer") {
        const body = s(origin?.body) || text;
        const from = names.get(s(origin?.from)) ?? (s(origin?.name) || "agent");
        const handBack = /\[Subagent hand-back\]/.test(body);
        const report = body
          .replace(/^[\s\S]*?\[Subagent hand-back\][^\n]*\n?/, "")
          .replace(/<\/?agent-message[^>]*>/g, "");
        push(
          handBack ? `REPORT from "${from}"` : `MESSAGE from "${from}"`,
          ends(report, 900, 400),
        );
        continue;
      }
      if (
        kind === "human" ||
        (!kind && typeof obj(e.message)?.content === "string")
      ) {
        if (e.isMeta) continue;
        push("USER", ends(humanText(text), 2_000));
        continue;
      }
      // Tool results: only an Agent's id (for naming its later reports) and
      // the exit of commands worth reporting.
      const result = obj(e.toolUseResult);
      for (const b of blocks) {
        if (b.type !== "tool_result") continue;
        const id = s(b.tool_use_id);
        const desc = byTool.get(id);
        if (desc && s(result?.agentId)) names.set(s(result?.agentId), desc);
        const cmd = bash.get(id);
        if (cmd) {
          push("SHELL", `${cmd}: ${b.is_error ? "FAILED" : "ok"}`);
          bash.delete(id);
        }
      }
      continue;
    }
    if (e.type === "assistant") {
      const { text, blocks } = contentOf(e);
      if (text.trim()) push("PM", ends(text, 1_200, 300));
      for (const b of blocks) {
        if (b.type !== "tool_use") continue;
        const input = obj(b.input) ?? {};
        const id = s(b.id);
        if (b.name === "Agent" || b.name === "Task") {
          const desc = s(input.description) || "agent";
          byTool.set(id, desc);
          push(`START agent "${desc}"`, ends(s(input.prompt), 500));
        } else if (b.name === "SendMessage") {
          const to = names.get(s(input.to)) ?? s(input.to);
          push(`PM → "${to}"`, ends(s(input.message), 500));
        } else if (b.name === "Bash") {
          const cmd = s(input.command);
          if (RELEASE.test(cmd) || COMMIT.test(cmd)) {
            bash.set(id, s(input.description) || ends(cmd, 120));
          }
        }
      }
    }
  }

  // Newest lines that fit, oldest first.
  const entries: Digest["entries"] = [];
  const out: string[] = [];
  let used = 0;
  let start = lines.length;
  while (start > 0) {
    const l = lines[start - 1];
    const cost = l.text.length + l.who.length + 24;
    if (used + cost > RECENT_CHARS) break;
    used += cost;
    start--;
  }
  lines.slice(start).forEach((l, i) => {
    const id = `e${i + 1}`;
    entries.push({ ...l, id });
    out.push(`[${id}] ${hhmm(l.at)} ${l.who}: ${l.text}`);
  });

  const parts = [];
  if (anchor) {
    parts.push(
      "<plan_anchor>\nThe session's own summary at its last context compaction (older; the log below is newer):\n" +
        ends(anchor.replace(/^[\s\S]*?\n\s*Summary:\s*\n/, ""), ANCHOR_CHARS) +
        "\n</plan_anchor>",
    );
  }
  parts.push(
    `<log omitted_earlier_lines="${start}">\n${out.join("\n")}\n</log>`,
  );
  return { text: parts.join("\n\n"), entries, lines: out.length };
}
