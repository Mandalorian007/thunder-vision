"use client";

import {
  ArrowLeft,
  Check,
  Copy,
  Ellipsis,
  Eraser,
  Pause,
  Pencil,
  Play,
  Square,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { LogTerminal } from "@/components/log-terminal";
import { RunDot, untilLabel, useNow, whenLabel } from "@/components/run-dots";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { copyText } from "@/lib/clipboard";
import {
  describeSchedule,
  duration,
  isRed,
  type JobSummary,
  type Run,
  STATUS_LABEL,
  taskLabel,
} from "@/lib/jobs";
import { toSessionName } from "@/lib/names";
import { cn } from "@/lib/utils";
import type { TmuxSession } from "@/server/tmux";

const POLL_MS = 2000;
const touchSize = "pointer-coarse:h-10";

async function call<T>(url: string, method: string, body: object): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

const fail = (fallback: string) => (err: unknown) =>
  toast.error(err instanceof Error ? err.message : fallback);

/** A job: what it does, its runs, and the selected run's result and log. */
export function JobView({
  job,
  runId,
  fontSize,
  onSelectRun,
  onEdit,
  onJobs,
  onDeleted,
  onOpenSession,
  onSwitchSession,
}: {
  job: JobSummary;
  runId: string | null;
  fontSize: number;
  onSelectRun(runId: string | null): void;
  onEdit(): void;
  onJobs(jobs: JobSummary[]): void;
  onDeleted(): void;
  onOpenSession(name: string, sessions: TmuxSession[]): void;
  onSwitchSession(name: string): void;
}) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [confirm, setConfirm] = useState<"clear" | "delete" | null>(null);
  const [withHistory, setWithHistory] = useState(true);
  const now = useNow();

  // Polled while visible, and refetched as soon as the sidebar's summary
  // (polled too) sees a new or finished run.
  const latest = job.recent.at(-1);
  const latestKey = latest ? `${latest.id}:${latest.status}` : "";
  useEffect(() => {
    let stale = false;
    const load = () =>
      fetch(`/api/runs?job=${job.id}`, { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then(
          (next: Run[] | null) => next && !stale && setRuns(next),
          () => {},
        );
    load();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, POLL_MS);
    return () => {
      stale = true;
      clearInterval(id);
    };
  }, [job.id, latestKey]);

  const selected = runs?.find((r) => r.id === runId) ?? null;

  const runNow = () =>
    call<{ run: Run; runs: Run[] }>("/api/runs", "POST", { job: job.id }).then(
      ({ run, runs }) => {
        setRuns(runs);
        if (run.status === "skipped") toast(run.note ?? "Already running");
        else onSelectRun(run.id);
      },
      fail("Couldn't start it"),
    );

  const toggle = () =>
    call<{ jobs: JobSummary[] }>("/api/jobs", "PATCH", {
      id: job.id,
      enabled: !job.enabled,
    }).then(({ jobs }) => onJobs(jobs), fail("Couldn't change it"));

  const clear = () =>
    call<{ runs: Run[] }>("/api/runs", "DELETE", { job: job.id }).then(
      ({ runs }) => {
        setRuns(runs);
        onSelectRun(null);
        toast("History cleared");
      },
      fail("Couldn't clear history"),
    );

  const remove = () =>
    call<{ jobs: JobSummary[] }>("/api/jobs", "DELETE", {
      id: job.id,
      history: withHistory,
    }).then(({ jobs }) => {
      onJobs(jobs);
      onDeleted();
      toast(`Deleted ${job.name}`);
    }, fail("Couldn't delete it"));

  const next =
    job.enabled && job.nextRunAt && now !== null
      ? `next ${untilLabel(job.nextRunAt, now)}`
      : job.enabled
        ? null
        : "paused";

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="shrink-0 border-b px-4 py-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold">{job.name}</h1>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
              <span>{describeSchedule(job.schedule)}</span>
              {next && (
                <>
                  <span aria-hidden>·</span>
                  <span className={cn(!job.enabled && "text-bolt")}>
                    {next}
                  </span>
                </>
              )}
              <span aria-hidden>·</span>
              <span className="font-mono">{job.dir}</span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" onClick={runNow} className={touchSize}>
              <Play /> <span className="max-sm:sr-only">Run now</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={toggle}
              aria-pressed={!job.enabled}
              className={touchSize}
            >
              {job.enabled ? <Pause /> : <Play />}
              <span className="max-sm:sr-only">
                {job.enabled ? "Pause" : "Resume"}
              </span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="More"
                  className="text-muted-foreground pointer-coarse:size-10"
                >
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                <DropdownMenuItem
                  onSelect={onEdit}
                  className="pointer-coarse:py-2.5"
                >
                  <Pencil /> Edit…
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => setConfirm("clear")}
                  className="pointer-coarse:py-2.5"
                >
                  <Eraser /> Clear history…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => {
                    setWithHistory(true);
                    setConfirm("delete");
                  }}
                  className="pointer-coarse:py-2.5"
                >
                  <Trash2 /> Delete job…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <p className="mt-2 line-clamp-2 font-mono text-xs break-all whitespace-pre-wrap text-foreground/80">
          {job.task.kind === "claude" && (
            <span className="text-muted-foreground">
              claude · {job.task.model} · {job.task.effort} ·{" "}
            </span>
          )}
          {job.task.kind === "shell" && (
            <span className="text-muted-foreground">$ </span>
          )}
          {taskLabel(job.task)}
        </p>
      </header>

      <div className="flex min-h-0 flex-1">
        <RunList
          runs={runs}
          selected={runId}
          onSelect={onSelectRun}
          now={now}
          className={cn(selected && "max-lg:hidden")}
        />
        {selected ? (
          <RunDetail
            key={selected.id}
            job={job}
            run={selected}
            now={now}
            fontSize={fontSize}
            onBack={() => onSelectRun(null)}
            onRuns={setRuns}
            onOpenSession={onOpenSession}
            onSwitchSession={onSwitchSession}
          />
        ) : (
          <div className="hidden flex-1 items-center justify-center text-sm text-muted-foreground lg:flex">
            {runs?.length ? "Pick a run to see its log." : null}
          </div>
        )}
      </div>

      <AlertDialog
        open={confirm === "clear"}
        onOpenChange={(open) => !open && setConfirm(null)}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Clear history?</AlertDialogTitle>
            <AlertDialogDescription>
              Deletes every finished run of {job.name} and its logs. A run in
              progress is kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className={touchSize}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className={touchSize}
              onClick={clear}
            >
              Clear history
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirm === "delete"}
        onOpenChange={(open) => !open && setConfirm(null)}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {job.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It stops running on schedule. A run in progress is stopped.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={withHistory}
              onChange={(e) => setWithHistory(e.target.checked)}
              className="size-4 accent-primary pointer-coarse:size-5"
            />
            Also delete its run history and logs
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel className={touchSize}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className={touchSize}
              onClick={remove}
            >
              Delete job
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const TRIGGER: Record<Run["trigger"], string | null> = {
  schedule: null,
  manual: "manual",
  "catch-up": "catch-up",
};

function runTime(run: Run, now: number | null) {
  if (run.status === "skipped") return null;
  const end = run.endedAt ? Date.parse(run.endedAt) : now;
  return end === null ? null : duration(end - Date.parse(run.startedAt));
}

function RunList({
  runs,
  selected,
  onSelect,
  now,
  className,
}: {
  runs: Run[] | null;
  selected: string | null;
  onSelect(id: string): void;
  now: number | null;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 w-full flex-col overflow-y-auto pb-[env(safe-area-inset-bottom)] [scrollbar-width:thin] lg:w-80 lg:shrink-0 lg:border-r",
        className,
      )}
    >
      <div className="px-4 pt-3 pb-1 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
        Runs
      </div>
      {runs?.length === 0 && (
        <p className="px-4 py-2 text-sm text-muted-foreground">
          No runs yet. Use Run now to try it.
        </p>
      )}
      <ul className="flex flex-col gap-0.5 px-2 pb-2">
        {runs?.map((r) => {
          const tag = TRIGGER[r.trigger];
          const time = runTime(r, now);
          return (
            <li key={r.id}>
              <button
                onClick={() => onSelect(r.id)}
                aria-current={r.id === selected}
                className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted aria-current:bg-muted pointer-coarse:py-3"
              >
                <RunDot status={r.status} />
                <span className="min-w-0 flex-1 truncate">
                  {now === null ? r.id : whenLabel(r.startedAt, now)}
                  {tag && (
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      {tag}
                    </span>
                  )}
                </span>
                <span
                  className={cn(
                    "shrink-0 text-xs tabular-nums",
                    isRed(r.status)
                      ? "text-destructive"
                      : "text-muted-foreground",
                  )}
                >
                  {r.status === "ok" || r.status === "running"
                    ? time
                    : STATUS_LABEL[r.status]}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The time, every second while `on`; null until the first tick. */
function useTicker(on: boolean) {
  const [time, setTime] = useState<number | null>(null);
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setTime(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return on ? time : null;
}

function RunDetail({
  job,
  run,
  now,
  fontSize,
  onBack,
  onRuns,
  onOpenSession,
  onSwitchSession,
}: {
  job: JobSummary;
  run: Run;
  now: number | null;
  fontSize: number;
  onBack(): void;
  onRuns(runs: Run[]): void;
  onOpenSession(name: string, sessions: TmuxSession[]): void;
  onSwitchSession(name: string): void;
}) {
  const running = run.status === "running";
  const tick = useTicker(running);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const result = run.claude?.result;
  const sessionId = run.claude?.sessionId;
  const elapsed = runTime(run, tick ?? now);

  const stop = () =>
    call<{ runs: Run[] }>("/api/runs", "PATCH", {
      job: job.id,
      run: run.id,
    }).then(({ runs }) => onRuns(runs), fail("Couldn't stop it"));

  const remove = () =>
    call<{ runs: Run[] }>("/api/runs", "DELETE", {
      job: job.id,
      run: run.id,
    }).then(({ runs }) => {
      onRuns(runs);
      onBack();
    }, fail("Couldn't delete it"));

  /** A tmux session with Claude picking this run's conversation back up. */
  const resume = async () => {
    if (!sessionId || job.task.kind !== "claude") return;
    setBusy(true);
    const { model, effort } = job.task;
    const name = toSessionName(`${job.id}-${run.id.slice(9, 13)}`);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dir: job.dir,
          name,
          command: `claude --resume ${sessionId} --permission-mode auto --model ${model} --effort ${effort}`,
        }),
      });
      const data = await res.json();
      if (res.status === 409) {
        toast(data.error, {
          action: {
            label: "Switch",
            onClick: () => onSwitchSession(data.name),
          },
        });
        return;
      }
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      onOpenSession(data.name, data.sessions);
    } catch (err) {
      fail("Couldn't open a session")(err);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (result && (await copyText(result))) setCopied(true);
  };
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Back to runs"
          onClick={onBack}
          className="text-muted-foreground lg:hidden pointer-coarse:size-10"
        >
          <ArrowLeft />
        </Button>
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <RunDot status={run.status} />
          <span
            className={cn(
              "font-medium",
              isRed(run.status) && "text-destructive",
            )}
          >
            {STATUS_LABEL[run.status]}
          </span>
          <span className="truncate text-muted-foreground">
            {now === null ? run.id : whenLabel(run.startedAt, now)}
            {elapsed && ` · ${elapsed}`}
            {run.claude?.turns ? ` · ${run.claude.turns} turns` : ""}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {running && (
            <Button
              size="sm"
              variant="outline"
              onClick={stop}
              className={touchSize}
            >
              <Square /> Stop
            </Button>
          )}
          {sessionId && !running && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={resume}
              className={touchSize}
            >
              <SquareTerminal /> Continue in session
            </Button>
          )}
          {!running && (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Delete this run"
              onClick={remove}
              className="text-muted-foreground pointer-coarse:size-10"
            >
              <Trash2 />
            </Button>
          )}
        </div>
      </div>

      {run.note && (
        <p
          className={cn(
            "shrink-0 border-b px-4 py-2 text-sm",
            isRed(run.status) ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {run.note}
        </p>
      )}

      {result && (
        <section className="relative max-h-[40%] shrink-0 overflow-y-auto border-b [scrollbar-width:thin]">
          <div className="sticky top-0 flex items-center justify-between bg-background/95 px-4 pt-2 pb-1 backdrop-blur">
            <span className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
              Final message
            </span>
            <Button
              size="xs"
              variant="ghost"
              onClick={copy}
              className="text-muted-foreground pointer-coarse:h-8"
            >
              {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <div className="px-4 pb-3 text-sm leading-relaxed break-words whitespace-pre-wrap select-text">
            {result}
          </div>
        </section>
      )}

      {run.status === "skipped" ? (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          Skipped runs have no log.
        </div>
      ) : (
        <LogTerminal jobId={job.id} runId={run.id} fontSize={fontSize} />
      )}
    </div>
  );
}
