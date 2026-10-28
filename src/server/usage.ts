import os from "node:os";
import path from "node:path";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { DATA_DIR, readJson, writeJson } from "./data";

export type UsageWindow = {
  /** 0–100. */
  usedPercentage: number;
  /** Epoch ms; 0 if unknown. */
  resetsAt: number;
};

export type Usage = {
  /** The Claude login: "max", "pro"… and its email. */
  plan: string | null;
  email: string | null;
  /** The rolling 5-hour window ("session" in /usage). */
  session: UsageWindow | null;
  week: UsageWindow | null;
  /** Epoch ms of the fetch. */
  updatedAt: number;
};

/**
 * Each check starts Claude Code, so it runs on the hour and every open page
 * shares the answer. A refresh is just an early one; the next is still on
 * the hour.
 */
const nextHour = (from: number) => {
  const d = new Date(from);
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return d.getTime();
};
/** A failed check tries again sooner, so the meters don't sit blank an hour. */
const RETRY_MS = 60_000;
/** The refresh button can't start checks closer together than this. */
const FORCE_GAP_MS = 30_000;
const TIMEOUT_MS = 20_000;

/** The last good check, so a server restart doesn't blank the meters. */
const CACHE_FILE = path.join(DATA_DIR, "usage.json");

const cached = readJson<Usage>(CACHE_FILE);
let last = typeof cached?.updatedAt === "number" ? cached : null;
// Picks up the hourly schedule where the last good check left it.
let nextCheck = last ? nextHour(last.updatedAt) : 0;
let lastAttempt = 0;
let inflight: Promise<Usage | null> | null = null;

function toWindow(
  raw:
    { utilization: number | null; resets_at: string | null } | null | undefined,
): UsageWindow | null {
  if (typeof raw?.utilization !== "number") return null;
  const resetsAt = raw.resets_at ? Date.parse(raw.resets_at) || 0 : 0;
  return { usedPercentage: raw.utilization, resetsAt };
}

/** Never yields, so Claude Code starts up but no prompt (or model call) is sent. */
const idle: AsyncIterable<SDKUserMessage> = {
  [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
};

/**
 * A check that came back without the limits it had before (the experimental
 * call hiccuped) is a failure, not news; API-key logins never have them.
 */
const hasLimits = (u: Usage) => u.session !== null || u.week !== null;

/** What /usage shows, asked of Claude Code itself (it holds the login). */
async function fetchUsage(): Promise<Usage | null> {
  const abortController = new AbortController();
  const q = query({
    prompt: idle,
    options: {
      abortController,
      // No transcript, no project settings or hooks: just the account.
      persistSession: false,
      settingSources: [],
      cwd: os.tmpdir(),
      pathToClaudeCodeExecutable: process.env.CLAUDE_BIN || undefined,
    },
  });
  const timer = setTimeout(() => abortController.abort(), TIMEOUT_MS);
  try {
    // Experimental in the SDK; if it changes shape, the meters just go blank.
    const [res, account] = await Promise.all([
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
        skipBehaviors: true,
      }),
      q.accountInfo().catch(() => null),
    ]);
    const limits = res.rate_limits_available ? res.rate_limits : null;
    return {
      plan: res.subscription_type ?? account?.subscriptionType ?? null,
      email: account?.email ?? null,
      session: toWindow(limits?.five_hour),
      week: toWindow(limits?.seven_day),
      updatedAt: Date.now(),
    };
  } finally {
    clearTimeout(timer);
    q.close();
  }
}

/**
 * Null until the first fetch succeeds; windows are null on API-key logins.
 * `force` checks now instead of waiting for the hour.
 */
export async function getUsage(force = false): Promise<Usage | null> {
  if (force && Date.now() - lastAttempt >= FORCE_GAP_MS) nextCheck = 0;
  if (Date.now() < nextCheck) {
    // A forced check waits for one already running rather than answer stale.
    const usage = force && inflight ? await inflight : last;
    return usage && withResets(usage);
  }
  // Throttled on attempts too, so failures don't retry on every poll.
  lastAttempt = Date.now();
  nextCheck = lastAttempt + RETRY_MS;
  inflight ??= fetchUsage()
    .catch((err) => {
      console.error("usage:", err instanceof Error ? err.message : err);
      return null;
    })
    .then((next) => {
      if (next && last && hasLimits(last) && !hasLimits(next)) {
        console.error(
          "usage: check came back without limits; keeping the last",
        );
        next = null;
      }
      // A failed check keeps the last good numbers and when they were taken.
      if (!next) return last;
      nextCheck = nextHour(Date.now());
      try {
        writeJson(CACHE_FILE, next);
      } catch {}
      return (last = next);
    })
    .finally(() => (inflight = null));
  // A background check doesn't hold up the page when there's something to show.
  const usage = force || !last ? await inflight : last;
  return usage && withResets(usage);
}

/** A window that has reset since the fetch starts again from nothing. */
function withResets(usage: Usage): Usage {
  const now = Date.now();
  const fix = (w: UsageWindow | null) =>
    w && w.resetsAt && w.resetsAt < now ? { ...w, usedPercentage: 0 } : w;
  return { ...usage, session: fix(usage.session), week: fix(usage.week) };
}
