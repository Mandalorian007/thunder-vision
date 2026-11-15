"use client";

import {
  Bot,
  CircleAlert,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  LoaderCircle,
  MessageSquare,
  Minimize2,
  Reply,
  Send,
  Sparkles,
  User,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type {
  AgentFact,
  EventKind,
  Facts,
  Lifecycle,
  OverviewEvent,
} from "@/lib/overview";
import { cn } from "@/lib/utils";

const POLL_MS = 5000;

function ago(iso: string | null, now: number) {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

function span(from: string, to: string | null, now: number) {
  const ms = (to ? Date.parse(to) : now) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function clock(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const tokens = (n: number | null) =>
  n == null ? "" : n >= 1000 ? `${Math.round(n / 1000)}k tok` : `${n} tok`;

const EVENT_ICON: Record<EventKind, ReactNode> = {
  human: <User />,
  spawn: <Bot />,
  handback: <Reply />,
  "agent-end": <Sparkles />,
  message: <Send />,
  pr: <GitPullRequest />,
  release: <GitMerge />,
  commit: <GitCommitHorizontal />,
  compact: <Minimize2 />,
  error: <CircleAlert />,
};

const LIFECYCLE: Record<Lifecycle, string> = {
  running: "bg-bolt/15 text-bolt",
  waiting: "bg-chart-3/15 text-chart-3",
  completed: "bg-muted text-muted-foreground",
  stopped: "bg-muted text-muted-foreground",
  failed: "bg-destructive/15 text-destructive",
  killed: "bg-destructive/15 text-destructive",
};

function Chip({ lifecycle }: { lifecycle: Lifecycle }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
        LIFECYCLE[lifecycle],
      )}
    >
      {lifecycle}
    </span>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {title}
        </h2>
        <div className="ml-auto text-xs text-muted-foreground">{aside}</div>
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col rounded-lg border bg-card px-3 py-2">
      <span className="text-lg leading-6 font-semibold tabular-nums">
        {value}
      </span>
      <span className="text-[11px] text-muted-foreground">{label}</span>
    </div>
  );
}

function AgentRow({ a, now }: { a: AgentFact; now: number }) {
  const live = a.lifecycle === "running" || a.lifecycle === "waiting";
  return (
    <li className="flex items-center gap-2 py-1.5 pointer-coarse:py-2.5">
      <Chip lifecycle={a.lifecycle} />
      <span className="min-w-0 flex-1 truncate">
        {a.description}
        {a.nested && (
          <span className="ml-1.5 text-xs text-muted-foreground">
            (sub-agent)
          </span>
        )}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {[
          a.type && a.type !== "general-purpose" ? a.type : "",
          tokens(a.tokens),
          a.spawnedAt
            ? live
              ? `${span(a.spawnedAt, null, now)} so far`
              : span(a.spawnedAt, a.endedAt, now)
            : "",
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
    </li>
  );
}

function EventRow({ e, isNew }: { e: OverviewEvent; isNew: boolean }) {
  return (
    <li
      className={cn(
        "flex gap-2.5 rounded-md px-2 py-1.5 pointer-coarse:py-2.5",
        isNew && "bg-primary/5",
        e.kind === "human" && "bg-muted/60",
      )}
    >
      <span
        className={cn(
          "mt-0.5 shrink-0 text-muted-foreground [&_svg]:size-3.5",
          e.alert && "text-destructive",
          e.kind === "human" && "text-foreground",
        )}
      >
        {EVENT_ICON[e.kind]}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 break-words",
          e.weight === 0 && e.kind !== "human" && "text-muted-foreground",
          e.alert && "text-destructive",
        )}
      >
        {e.text}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {clock(e.at)}
      </span>
    </li>
  );
}

/**
 * The Overview tab: what the Claude session in this tmux session has been
 * doing, counted from its transcript. Read-only; it never acts.
 */
export function OverviewView({
  session,
  newEvents,
}: {
  session: string;
  /** From the session poll: new events arrived, so mark them seen. */
  newEvents: number;
}) {
  const [facts, setFacts] = useState<Facts | null>(null);
  const [missing, setMissing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [allAgents, setAllAgents] = useState(false);
  const [keyOnly, setKeyOnly] = useState(true);
  // What was already seen when the tab opened: newer events are highlighted.
  const [seenAtOpen, setSeenAtOpen] = useState<string | null>();

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const res = await fetch(
          `/api/overview?session=${encodeURIComponent(session)}`,
          { cache: "no-store" },
        );
        if (stopped) return;
        if (res.status === 404) {
          setMissing(true);
          return;
        }
        const data: { facts: Facts | null } = await res.json();
        if (stopped) return;
        setMissing(false);
        if (data.facts) {
          const seenAt = data.facts.seenAt;
          setSeenAtOpen((prev) => (prev === undefined ? seenAt : prev));
          setFacts(data.facts);
        }
        setNow(Date.now());
      } catch {}
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [session]);

  // Looking at it counts as seeing it: clears the badge.
  useEffect(() => {
    fetch("/api/overview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session }),
    }).catch(() => {});
  }, [session, newEvents]);

  if (missing) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        No Claude session is running in {session} right now.
      </div>
    );
  }
  if (!facts) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" /> Reading the transcript…
      </div>
    );
  }

  const agents = facts.agents.filter((a) => !a.nested);
  const active = facts.agents.filter(
    (a) => a.lifecycle === "running" || a.lifecycle === "waiting",
  );
  const finished = agents
    .filter((a) => a.lifecycle !== "running" && a.lifecycle !== "waiting")
    .sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""));
  const failed = finished.filter(
    (a) => a.lifecycle === "failed" || a.lifecycle === "killed",
  ).length;
  const seen = seenAtOpen ?? "";
  const events = facts.events
    .filter((e) => !keyOnly || e.weight > 0 || e.kind === "human")
    .slice(-60)
    .reverse();
  const lastHuman = [...facts.events].reverse().find((e) => e.kind === "human");
  const program = facts.kind === "program";

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
        <header className="flex flex-col gap-1">
          <h1 className="text-base font-semibold">{facts.title ?? session}</h1>
          <p className="text-xs text-muted-foreground">
            {[
              facts.cwd.replace(/^\/Users\/[^/]+/, "~"),
              facts.branch,
              facts.status === "busy"
                ? "working"
                : facts.status === "shell"
                  ? "running a command"
                  : facts.status,
              `last activity ${ago(facts.lastActivity, now)}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </header>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {program ? (
            <>
              <Stat
                label={
                  facts.pendingBackground
                    ? `agents active · ${facts.pendingBackground} pending`
                    : "agents active"
                }
                value={active.length}
              />
              <Stat
                label={
                  failed ? `agents done · ${failed} failed` : "agents done"
                }
                value={finished.length}
              />
              <Stat label="merges & releases" value={facts.counts.releases} />
              <Stat label="PRs" value={facts.counts.prs} />
            </>
          ) : (
            <>
              <Stat label="your messages" value={facts.counts.human} />
              <Stat label="commits" value={facts.counts.commits} />
              <Stat label="PRs" value={facts.counts.prs} />
              <Stat label="compactions" value={facts.counts.compactions} />
            </>
          )}
        </div>

        {lastHuman && (
          <Section title="Your last message" aside={ago(lastHuman.at, now)}>
            <p className="rounded-lg border bg-card px-3 py-2 text-sm whitespace-pre-wrap">
              {lastHuman.text}
            </p>
          </Section>
        )}

        {(program || active.length > 0) && (
          <Section title="Agents now" aside={`${active.length} active`}>
            {active.length ? (
              <ul className="divide-y text-sm">
                {active.map((a) => (
                  <AgentRow key={a.toolUseId} a={a} now={now} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No agents running.
              </p>
            )}
          </Section>
        )}

        <Section
          title="Activity"
          aside={
            <button
              onClick={() => setKeyOnly(!keyOnly)}
              className="rounded px-1.5 py-0.5 hover:bg-muted pointer-coarse:py-1.5"
            >
              {keyOnly ? "Show messages to agents" : "Key events only"}
            </button>
          }
        >
          <ul className="flex flex-col text-sm">
            {events.map((e, i) => (
              <EventRow
                key={`${e.uuid}:${i}`}
                e={e}
                isNew={!!seen && e.at > seen}
              />
            ))}
          </ul>
        </Section>

        {finished.length > 0 && (
          <Section title="Finished agents" aside={`${finished.length} total`}>
            <ul className="divide-y text-sm">
              {(allAgents ? finished : finished.slice(0, 10)).map((a) => (
                <AgentRow key={a.toolUseId} a={a} now={now} />
              ))}
            </ul>
            {finished.length > 10 && (
              <button
                onClick={() => setAllAgents(!allAgents)}
                className="self-start rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted pointer-coarse:py-1.5"
              >
                {allAgents ? "Show fewer" : `Show all ${finished.length}`}
              </button>
            )}
          </Section>
        )}

        {facts.prs.length > 0 && (
          <Section title="Pull requests" aside={`${facts.prs.length} linked`}>
            <div className="flex flex-wrap gap-1.5">
              {facts.prs
                .slice(-16)
                .reverse()
                .map((p) => (
                  <a
                    key={`${p.repo}#${p.number}`}
                    href={p.url}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-full border px-2.5 py-0.5 font-mono text-xs hover:bg-muted pointer-coarse:py-1.5"
                  >
                    #{p.number}
                  </a>
                ))}
            </div>
          </Section>
        )}

        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <MessageSquare className="size-3" />
          Counted from the session transcript ({facts.counts.compactions}{" "}
          compactions so far). No model involved.
        </p>
      </div>
    </div>
  );
}
