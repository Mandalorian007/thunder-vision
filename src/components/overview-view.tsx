"use client";

import {
  Bot,
  ChevronRight,
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
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Summary } from "@/components/rich-text";
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

const LANDED = new Set<EventKind>(["handback", "release", "pr", "error"]);

function AgentRow({
  a,
  now,
  last,
}: {
  a: AgentFact;
  now: number;
  /** The session's latest message to it. */
  last?: string;
}) {
  const live = a.lifecycle === "running" || a.lifecycle === "waiting";
  return (
    <li className="flex items-center gap-2 py-1.5 pointer-coarse:py-2.5">
      <Chip lifecycle={a.lifecycle} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">
          {a.description}
          {a.nested && (
            <span className="ml-1.5 text-xs text-muted-foreground">
              (sub-agent)
            </span>
          )}
        </span>
        {last && (
          <span className="truncate text-xs text-muted-foreground">
            Last told: {last}
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

function dayLabel(iso: string, now: number) {
  const d = new Date(iso);
  const days = Math.round(
    (new Date(now).setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) /
      86_400_000,
  );
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function EventRow({
  e,
  isNew,
  when,
}: {
  e: OverviewEvent;
  isNew: boolean;
  /** Shown instead of the clock time. */
  when?: string;
}) {
  const [open, setOpen] = useState(false);
  const quiet = e.weight === 0 && e.kind !== "human";
  const line = (
    <>
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
          quiet && "text-muted-foreground",
          e.alert && "text-destructive",
          !open && "line-clamp-3",
        )}
      >
        {e.who && (
          <span className={cn("font-medium", !quiet && "text-foreground")}>
            {e.who}
            {e.text ? " " : ""}
          </span>
        )}
        {e.who && e.text && <span className="text-muted-foreground">· </span>}
        {e.text}
      </span>
      <span className="flex shrink-0 items-start gap-1 text-xs text-muted-foreground tabular-nums">
        {when ?? clock(e.at)}
        {e.detail && (
          <ChevronRight
            className={cn(
              "mt-px size-3.5 transition-transform",
              open && "rotate-90",
            )}
          />
        )}
      </span>
    </>
  );
  const row = cn(
    "flex w-full gap-2.5 rounded-md px-2 py-1.5 text-left pointer-coarse:py-2.5",
    isNew && "bg-primary/5",
    e.kind === "human" && "bg-muted/60",
  );
  if (!e.detail) {
    return (
      <li>
        <div className={row}>{line}</div>
      </li>
    );
  }
  return (
    <li>
      <button
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          row,
          "outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50",
        )}
      >
        {line}
      </button>
      {open && (
        <div className="mt-1 mb-2 ml-8 rounded-lg border bg-card px-3 py-2.5">
          <Summary text={e.detail} />
        </div>
      )}
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
    .filter((e) => !keyOnly || (e.weight > 0 && e.kind !== "human"))
    .slice(-60)
    .reverse();
  const landed = facts.events
    .filter((e) => LANDED.has(e.kind))
    .slice(-8)
    .reverse();
  // The latest word between the session and each agent: what it was told.
  const lastWord = new Map<string, string>();
  for (const e of facts.events) {
    if (e.kind === "message" && e.who) lastWord.set(e.who.slice(2), e.text);
  }
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
              <Stat label="agents run" value={facts.counts.spawns} />
              <Stat label="commits" value={facts.counts.commits} />
              <Stat label="PRs" value={facts.counts.prs} />
              <Stat label="compactions" value={facts.counts.compactions} />
            </>
          )}
        </div>

        {(program || active.length > 0) && (
          <Section title="In flight" aside={`${active.length} active`}>
            {active.length ? (
              <ul className="divide-y text-sm">
                {active.map((a) => (
                  <AgentRow
                    key={a.toolUseId}
                    a={a}
                    now={now}
                    last={lastWord.get(a.description)}
                  />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                Nothing running right now.
              </p>
            )}
          </Section>
        )}

        {landed.length > 0 && (
          <Section title="Landed" aside="reports, merges, PRs">
            <ul className="flex flex-col gap-px text-sm">
              {landed.map((e, i) => (
                <EventRow
                  key={`${e.uuid}:${i}`}
                  e={e}
                  isNew={!!seen && e.at > seen}
                  when={ago(e.at, now)}
                />
              ))}
            </ul>
          </Section>
        )}

        <Section
          title="Activity"
          aside={
            <button
              onClick={() => setKeyOnly(!keyOnly)}
              className="rounded px-1.5 py-0.5 hover:bg-muted pointer-coarse:py-1.5"
            >
              {keyOnly ? "Show everything" : "Key events only"}
            </button>
          }
        >
          <ul className="flex flex-col gap-px text-sm">
            {events.map((e, i) => {
              const day = dayLabel(e.at, now);
              const prev = i > 0 ? dayLabel(events[i - 1].at, now) : null;
              return (
                <Fragment key={`${e.uuid}:${i}`}>
                  {day !== prev && (
                    <li className="sticky top-0 z-10 bg-background/95 px-2 pt-3 pb-1 text-[11px] font-medium text-muted-foreground backdrop-blur first:pt-0">
                      {day}
                    </li>
                  )}
                  <EventRow e={e} isNew={!!seen && e.at > seen} />
                </Fragment>
              );
            })}
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
