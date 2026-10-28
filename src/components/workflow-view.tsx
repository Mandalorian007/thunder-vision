"use client";

import {
  ArrowLeft,
  Check,
  Copy,
  Ellipsis,
  Eraser,
  ExternalLink,
  FileText,
  GitBranch,
  GitPullRequest,
  Minus,
  Pause,
  Pencil,
  Play,
  Sparkles,
  Square,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { whereLabel } from "@/components/workflow-list";
import { copyText } from "@/lib/clipboard";
import { toSessionName } from "@/lib/names";
import { editWithClaude, openSession } from "@/lib/open-session";
import { shellPath } from "@/lib/upload";
import { cn } from "@/lib/utils";
import {
  describeSchedule,
  duration,
  isRed,
  isUrl,
  prLabel,
  type Run,
  type RunFiles,
  STATUS_LABEL,
  type StepRun,
  slugify,
  type WorkflowSummary,
} from "@/lib/workflows";
import type { TmuxSession } from "@/server/tmux";

const POLL_MS = 2000;
const touchSize = "pointer-coarse:h-10";
const sectionTitle =
  "text-[11px] font-medium tracking-wider text-muted-foreground uppercase";

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

/** "~/a b/c.yml" → ~/'a b/c.yml': quoted, with the ~ still expanding. */
const shellFile = (p: string) =>
  p.startsWith("~/") ? `~/${shellPath(p.slice(2))}` : shellPath(p);

/** A repo's file as ".thunder/workflows/x.yml"; a local one as its path. */
const fileLabel = (wf: WorkflowSummary) => {
  const at = wf.repo ? wf.file.lastIndexOf("/.thunder/") : -1;
  return at < 0 ? wf.file : wf.file.slice(at + 1);
};

type SessionProps = {
  onOpenSession(name: string, sessions: TmuxSession[]): void;
  onSwitchSession(name: string): void;
};

/** A workflow: what it does, its runs, and the selected run in full. */
export function WorkflowView({
  workflow: wf,
  runId,
  fontSize,
  docs,
  onSelectRun,
  onWorkflows,
  onOpenSession,
  onSwitchSession,
}: {
  workflow: WorkflowSummary;
  runId: string | null;
  fontSize: number;
  docs: string;
  onSelectRun(runId: string | null): void;
  onWorkflows(workflows: WorkflowSummary[]): void;
} & SessionProps) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [asking, setAsking] = useState(false);
  const now = useNow();
  const sessions = { opened: onOpenSession, switchTo: onSwitchSession };

  // Polled while visible, and refetched as soon as the sidebar's summary
  // (polled too) sees a new or finished run.
  const latest = wf.recent.at(-1);
  const latestKey = latest ? `${latest.id}:${latest.status}` : "";
  useEffect(() => {
    let stale = false;
    const load = () =>
      fetch(`/api/runs?workflow=${wf.id}`, { cache: "no-store" })
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
  }, [wf.id, latestKey]);

  const selected = runs?.find((r) => r.id === runId) ?? null;

  const start = (inputs: Record<string, string> = {}) =>
    call<{ run: Run; runs: Run[] }>("/api/runs", "POST", {
      workflow: wf.id,
      inputs,
    }).then(({ run, runs }) => {
      setRuns(runs);
      setAsking(false);
      if (run.status === "skipped") toast(run.note ?? "Already running");
      else onSelectRun(run.id);
    }, fail("Couldn't start it"));

  const toggle = () =>
    call<{ workflows: WorkflowSummary[] }>("/api/workflows", "PATCH", {
      id: wf.id,
      enabled: !wf.enabled,
    }).then(
      ({ workflows }) => onWorkflows(workflows),
      fail("Couldn't change it"),
    );

  const clear = () =>
    call<{ runs: Run[] }>("/api/runs", "DELETE", { workflow: wf.id }).then(
      ({ runs }) => {
        setRuns(runs);
        onSelectRun(null);
        toast("History cleared");
      },
      fail("Couldn't clear history"),
    );

  const edit = (command: string) =>
    openSession(
      {
        dir: wf.dir,
        name: toSessionName(`wf-${slugify(wf.id.split("--").pop() ?? wf.id)}`),
        command,
      },
      sessions,
    ).catch(fail("Couldn't open a session"));
  const editClaude = () => edit(editWithClaude(wf.file, docs));
  const editFile = () => edit(`\${EDITOR:-vi} ${shellFile(wf.file)}`);

  const next =
    wf.schedule && wf.enabled && wf.nextRunAt && now !== null
      ? `next ${untilLabel(wf.nextRunAt, now)}`
      : wf.schedule && !wf.enabled
        ? "paused"
        : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="shrink-0 border-b px-4 py-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold">{wf.name}</h1>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
              <span>{describeSchedule(wf.schedule)}</span>
              {next && (
                <>
                  <span aria-hidden>·</span>
                  <span className={cn(!wf.enabled && "text-bolt")}>{next}</span>
                </>
              )}
              <span aria-hidden>·</span>
              <span className="font-mono">{whereLabel(wf)}</span>
              <span aria-hidden className="max-sm:hidden">
                ·
              </span>
              <span className="font-mono break-all max-sm:hidden">
                {fileLabel(wf)}
              </span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="sm"
              disabled={!!wf.error}
              onClick={() => (wf.inputs.length ? setAsking(true) : start())}
              className={touchSize}
            >
              <Play /> <span className="max-sm:sr-only">Run</span>
            </Button>
            {wf.schedule && !wf.error && (
              <Button
                size="sm"
                variant="outline"
                onClick={toggle}
                aria-pressed={!wf.enabled}
                className={touchSize}
              >
                {wf.enabled ? <Pause /> : <Play />}
                <span className="max-sm:sr-only">
                  {wf.enabled ? "Pause" : "Resume"}
                </span>
              </Button>
            )}
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
              <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuItem
                  onSelect={editClaude}
                  className="pointer-coarse:py-2.5"
                >
                  <Sparkles /> Edit with Claude
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={editFile}
                  className="pointer-coarse:py-2.5"
                >
                  <Pencil /> Open in editor
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    copyText(wf.file).then(
                      (ok) => ok && toast("Copied the path"),
                    )
                  }
                  className="pointer-coarse:py-2.5"
                >
                  <Copy /> Copy path
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => setConfirm(true)}
                  className="pointer-coarse:py-2.5"
                >
                  <Eraser /> Clear history…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {wf.error ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
            <span className="min-w-0 flex-1 font-mono break-words whitespace-pre-wrap text-destructive">
              {wf.error}
            </span>
            <Button
              size="xs"
              variant="outline"
              onClick={editClaude}
              className="pointer-coarse:h-8"
            >
              <Sparkles /> Fix with Claude
            </Button>
          </div>
        ) : (
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="min-w-0 font-mono break-words text-foreground/80">
              {wf.steps.map((s) => s.id).join(" → ")}
            </span>
            <span className="ml-auto">
              {wf.worktree
                ? `worktree${wf.worktree.base ? ` from ${wf.worktree.base}` : ""}`
                : "in the folder"}
              {` · ${wf.timeoutMin}m`}
            </span>
          </p>
        )}
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
            wf={wf}
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
            {runs?.length ? "Pick a run to see what it did." : null}
          </div>
        )}
      </div>

      <InputsDialog
        wf={wf}
        open={asking}
        onOpenChange={setAsking}
        onRun={start}
      />

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Clear history?</AlertDialogTitle>
            <AlertDialogDescription>
              Deletes every finished run of {wf.name}, its logs, and any
              worktree a failed run kept. A run in progress is kept.
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
    </div>
  );
}

/** Run, asking for the workflow's inputs first. */
function InputsDialog({
  wf,
  open,
  onOpenChange,
  onRun,
}: {
  wf: WorkflowSummary;
  open: boolean;
  onOpenChange(open: boolean): void;
  onRun(inputs: Record<string, string>): Promise<unknown>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const value = (name: string, fallback: string) => values[name] ?? fallback;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setValues({});
        onOpenChange(next);
      }}
    >
      <DialogContent
        showCloseButton={false}
        onCloseAutoFocus={(e) => e.preventDefault()}
        className="top-[max(1rem,6dvh)] max-h-[calc(100dvh-2rem)] translate-y-0 overflow-y-auto sm:max-w-lg"
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            setBusy(true);
            const inputs = Object.fromEntries(
              wf.inputs.map((i) => [i.name, value(i.name, i.default)]),
            );
            onRun(inputs).finally(() => setBusy(false));
          }}
        >
          <DialogHeader>
            <DialogTitle>Run {wf.name}</DialogTitle>
            <DialogDescription>
              {whereLabel(wf)} ·{" "}
              {wf.worktree
                ? `new worktree from ${wf.worktree.base ?? "origin's default branch"}`
                : "in the folder"}
            </DialogDescription>
          </DialogHeader>
          {wf.inputs.map((input, i) => (
            <label key={input.name} className="flex min-w-0 flex-col gap-1.5">
              <span className="font-mono text-xs font-medium text-muted-foreground">
                {input.name}
              </span>
              <Textarea
                autoFocus={i === 0}
                value={value(input.name, input.default)}
                onChange={(e) =>
                  setValues((v) => ({ ...v, [input.name]: e.target.value }))
                }
                rows={3}
                className="max-h-60 min-h-20 pointer-coarse:text-base"
              />
              {input.description && (
                <span className="text-xs text-muted-foreground">
                  {input.description}
                </span>
              )}
            </label>
          ))}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className={touchSize}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy} className={touchSize}>
              <Play /> Run
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const TRIGGER: Record<Run["trigger"], string | null> = {
  schedule: null,
  manual: "manual",
  "catch-up": "catch-up",
};

function span(
  from: string | undefined,
  to: string | undefined,
  now: number | null,
) {
  if (!from) return null;
  const end = to ? Date.parse(to) : now;
  return end === null ? null : duration(end - Date.parse(from));
}

const runTime = (run: Run, now: number | null) =>
  run.status === "skipped" ? null : span(run.startedAt, run.endedAt, now);

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
      <div className={cn(sectionTitle, "px-4 pt-3 pb-1")}>Runs</div>
      {runs?.length === 0 && (
        <p className="px-4 py-2 text-sm text-muted-foreground">
          No runs yet. Use Run to try it.
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
                {r.outputs?.pr && (
                  <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
                    <GitPullRequest className="size-3" />
                    {prLabel(r.outputs.pr).replace(/^PR /, "")}
                  </span>
                )}
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

function StepIcon({ status }: { status: StepRun["status"] }) {
  const cls = "size-3.5 shrink-0";
  if (status === "running")
    return <RunDot status="running" className="mx-[3px]" />;
  if (status === "ok") return <Check className={cn(cls, "text-emerald-500")} />;
  if (isRed(status)) return <X className={cn(cls, "text-destructive")} />;
  if (status === "nochange")
    return <Minus className={cn(cls, "text-muted-foreground")} />;
  if (status === "cancelled") {
    return <Square className={cn(cls, "scale-75 text-muted-foreground")} />;
  }
  return (
    <span className="mx-[5px] size-1 shrink-0 rounded-full bg-muted-foreground/50" />
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex min-h-6 items-center justify-between">
        <h2 className={sectionTitle}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const linkCls =
  "text-primary underline-offset-2 hover:underline focus-visible:underline outline-none";

/** $TV_SUMMARY. Raw HTML in it is shown as text, not rendered. */
function Summary({ text }: { text: string }) {
  return (
    <div className="text-sm leading-relaxed break-words select-text [&_:is(p,ul,ol,pre,table,blockquote,h1,h2,h3,h4)]:my-2 [&>:first-child]:mt-0 [&>:last-child]:mb-0">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" className={linkCls}>
              {children}
            </a>
          ),
          h1: ({ children }) => (
            <h3 className="text-base font-semibold">{children}</h3>
          ),
          h2: ({ children }) => (
            <h3 className="text-sm font-semibold">{children}</h3>
          ),
          h3: ({ children }) => (
            <h4 className="text-sm font-semibold">{children}</h4>
          ),
          ul: ({ children }) => <ul className="list-disc pl-5">{children}</ul>,
          ol: ({ children }) => (
            <ol className="list-decimal pl-5">{children}</ol>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 pl-3 text-muted-foreground">
              {children}
            </blockquote>
          ),
          code: ({ children, className }) => (
            <code
              className={cn(
                "rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]",
                className,
              )}
            >
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs [&_code]:bg-transparent [&_code]:p-0">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="text-xs [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left">
                {children}
              </table>
            </div>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

const sizeLabel = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1 << 20
      ? `${Math.round(n / 1024)} KB`
      : `${(n / (1 << 20)).toFixed(1)} MB`;

function RunDetail({
  wf,
  run,
  now,
  fontSize,
  onBack,
  onRuns,
  onOpenSession,
  onSwitchSession,
}: {
  wf: WorkflowSummary;
  run: Run;
  now: number | null;
  fontSize: number;
  onBack(): void;
  onRuns(runs: Run[]): void;
} & SessionProps) {
  const running = run.status === "running";
  const tick = useTicker(running);
  const at = tick ?? now;
  const [files, setFiles] = useState<RunFiles | null>(null);
  // null: every step's log.
  const [step, setStep] = useState<number | null>(null);
  // Below lg, details and the log share the height as tabs.
  const [tab, setTab] = useState<"details" | "log">("details");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"discard" | "delete" | null>(null);

  const wt = run.worktree;
  const kept = !!wt && wt.state !== "removed" && !running;
  const failedAt = run.steps.findIndex((s) => isRed(s.status));
  const failedStep = failedAt >= 0 ? run.steps[failedAt] : undefined;
  // The conversation to pick up: the failed step's, else the last one.
  const sessionId =
    failedStep?.claude?.sessionId ??
    run.steps.findLast((s) => s.claude?.sessionId)?.claude?.sessionId;
  const summary = files?.summary ?? run.result ?? null;
  const outputs = Object.entries(run.outputs ?? {}).filter(([k]) => k !== "pr");
  const pr = run.outputs?.pr;

  // Summary and artifacts land as steps finish.
  const doneSteps = run.steps.filter((s) => s.endedAt).length;
  useEffect(() => {
    let stale = false;
    fetch(`/api/runs?workflow=${wf.id}&run=${run.id}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (data: (RunFiles & { run: Run }) | null) =>
          data &&
          !stale &&
          setFiles({ summary: data.summary, artifacts: data.artifacts }),
        () => {},
      );
    return () => {
      stale = true;
    };
  }, [wf.id, run.id, run.status, doneSteps]);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  const act = (action: "stop" | "discard", fallback: string) =>
    call<{ runs: Run[] }>("/api/runs", "PATCH", {
      workflow: wf.id,
      run: run.id,
      action,
    }).then(({ runs }) => onRuns(runs), fail(fallback));

  const remove = () =>
    call<{ runs: Run[] }>("/api/runs", "DELETE", {
      workflow: wf.id,
      run: run.id,
    }).then(({ runs }) => {
      onRuns(runs);
      onBack();
    }, fail("Couldn't delete it"));

  /** tmux in the kept worktree (or the folder), resuming Claude if it ran. */
  const resume = async () => {
    setBusy(true);
    try {
      await openSession(
        {
          dir: kept && wt ? wt.path : wf.dir,
          name: toSessionName(`${slugify(wf.name)}-${run.id.slice(9, 13)}`),
          command: sessionId
            ? `claude --resume ${sessionId} --permission-mode auto`
            : "",
        },
        { opened: onOpenSession, switchTo: onSwitchSession },
      );
    } catch (err) {
      fail("Couldn't open a session")(err);
    } finally {
      setBusy(false);
    }
  };
  const canResume =
    !running && (kept || (!wt && !!sessionId && run.status !== "skipped"));

  const artifactUrl = (p: string) =>
    `/api/runs/artifact?${new URLSearchParams({ workflow: wf.id, run: run.id, path: p })}`;

  const steps = run.steps.length > 0 && (
    <Section title="Steps">
      <ol className="flex flex-col gap-0.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-1">
        {run.steps.map((s, i) => (
          <li key={s.id} className="flex items-center gap-1">
            {i > 0 && (
              <span
                aria-hidden
                className="hidden h-px w-3 bg-border sm:block"
              />
            )}
            <button
              aria-pressed={step === i}
              onClick={() => {
                setStep(step === i ? null : i);
                setTab("log");
              }}
              title={`${STATUS_LABEL[s.status]}: show this step's log`}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-muted aria-pressed:bg-muted aria-pressed:ring-1 aria-pressed:ring-primary/50 sm:w-auto pointer-coarse:py-3"
            >
              <StepIcon status={s.status} />
              <span
                className={cn(
                  "font-mono text-xs",
                  s.status === "pending" && "text-muted-foreground",
                  isRed(s.status) && "text-destructive",
                )}
              >
                {s.id}
              </span>
              <span className="ml-auto pl-2 text-xs text-muted-foreground tabular-nums sm:ml-0 sm:pl-0">
                {span(s.startedAt, s.endedAt, at) ??
                  (running ? "" : STATUS_LABEL[s.status])}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </Section>
  );

  const details = (
    <div className="flex flex-col gap-4 px-4 py-3">
      {run.note && (
        <p
          className={cn(
            "text-sm",
            isRed(run.status) ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {run.note}
        </p>
      )}

      {(pr || wt) && (
        <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
          {pr && (
            <a
              href={pr}
              target="_blank"
              rel="noreferrer"
              className="flex w-fit items-center gap-1.5 font-medium hover:underline"
            >
              <GitPullRequest className="size-4 text-emerald-500" />
              {prLabel(pr)}
              <ExternalLink className="size-3 text-muted-foreground" />
            </a>
          )}
          {wt && (
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <GitBranch className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate font-mono">{wt.branch}</span>
              <span className="shrink-0">
                ·{" "}
                {running
                  ? "in progress"
                  : wt.state === "removed"
                    ? wt.branchKept
                      ? "worktree removed, branch kept"
                      : "removed"
                    : "worktree kept for you"}
              </span>
            </div>
          )}
          {kept && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={resume}
                className={touchSize}
              >
                <SquareTerminal /> Continue in session
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirm("discard")}
                className={cn("text-muted-foreground", touchSize)}
              >
                Discard worktree
              </Button>
            </div>
          )}
        </div>
      )}

      {steps}

      {summary && (
        <Section
          title={files?.summary ? "Summary" : "Claude's last message"}
          action={
            <Button
              size="xs"
              variant="ghost"
              onClick={async () => setCopied(await copyText(summary))}
              className="text-muted-foreground pointer-coarse:h-8"
            >
              {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
            </Button>
          }
        >
          <Summary text={summary} />
        </Section>
      )}

      {outputs.length > 0 && (
        <Section title="Outputs">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            {outputs.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="font-mono text-xs leading-5 text-muted-foreground">
                  {k}
                </dt>
                <dd className="min-w-0 break-words whitespace-pre-wrap select-text">
                  {isUrl(v) ? (
                    <a
                      href={v.trim()}
                      target="_blank"
                      rel="noreferrer"
                      className={linkCls}
                    >
                      {v.trim()}
                    </a>
                  ) : (
                    v
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      )}

      {!!files?.artifacts.length && (
        <Section title="Artifacts">
          <ul className="flex flex-wrap gap-1.5">
            {files.artifacts.map((a) => (
              <li key={a.path}>
                <a
                  href={artifactUrl(a.path)}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs hover:bg-muted pointer-coarse:py-2"
                >
                  <FileText className="size-3.5 text-muted-foreground" />
                  <span className="font-mono">{a.path}</span>
                  <span className="text-muted-foreground">
                    {sizeLabel(a.size)}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );

  const logTabs = run.steps.length > 1 && (
    <div
      role="tablist"
      aria-label="Log"
      className="flex shrink-0 gap-1 overflow-x-auto border-b px-3 py-1.5 [scrollbar-width:none]"
    >
      {[null, ...run.steps.map((_, i) => i)].map((i) => (
        <button
          key={i ?? "all"}
          role="tab"
          aria-selected={step === i}
          onClick={() => setStep(i)}
          className="shrink-0 rounded-md px-2 py-0.5 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground aria-selected:bg-muted aria-selected:text-foreground pointer-coarse:py-2"
        >
          {i === null ? "all" : run.steps[i].id}
        </button>
      ))}
    </div>
  );

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
              "font-medium whitespace-nowrap",
              isRed(run.status) && "text-destructive",
            )}
          >
            {STATUS_LABEL[run.status]}
            {failedStep && ` at ${failedStep.id}`}
          </span>
          <span className="truncate text-muted-foreground">
            {now === null ? run.id : whenLabel(run.startedAt, now)}
            {runTime(run, at) && ` · ${runTime(run, at)}`}
            {TRIGGER[run.trigger] && ` · ${TRIGGER[run.trigger]}`}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {running && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => act("stop", "Couldn't stop it")}
              className={touchSize}
            >
              <Square /> Stop
            </Button>
          )}
          {canResume && !kept && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={resume}
              className={touchSize}
            >
              <SquareTerminal />
              <span className="max-sm:sr-only">Continue in session</span>
            </Button>
          )}
          {!running && (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Delete this run"
              onClick={() => (kept ? setConfirm("delete") : remove())}
              className="text-muted-foreground pointer-coarse:size-10"
            >
              <Trash2 />
            </Button>
          )}
        </div>
      </div>

      {run.status === "skipped" ? (
        <div className="flex flex-1 flex-col">
          {details}
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
            Skipped runs have no log.
          </div>
        </div>
      ) : (
        <>
          <div
            role="tablist"
            aria-label="Run"
            className="flex shrink-0 gap-1 border-b px-3 py-1.5 lg:hidden"
          >
            {(["details", "log"] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className="rounded-md px-2.5 py-1 text-xs font-medium tracking-wider text-muted-foreground uppercase aria-selected:bg-muted aria-selected:text-foreground pointer-coarse:py-2"
              >
                {t}
              </button>
            ))}
          </div>
          <div
            className={cn(
              "min-h-0 shrink-0 overflow-y-auto [scrollbar-width:thin] max-lg:flex-1 lg:max-h-[45%] lg:border-b",
              tab === "log" && "max-lg:hidden",
            )}
          >
            {details}
          </div>
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col",
              tab === "details" && "max-lg:hidden",
            )}
          >
            {logTabs}
            <LogTerminal
              key={step ?? "all"}
              workflowId={wf.id}
              runId={run.id}
              step={step ?? undefined}
              fontSize={fontSize}
            />
          </div>
        </>
      )}

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "delete"
                ? "Delete this run?"
                : "Discard the worktree?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Removes {wt?.path} and its local branch {wt?.branch}. Anything not
              pushed is lost.
              {confirm === "delete" && " The run's log goes too."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className={touchSize}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className={touchSize}
              onClick={() =>
                confirm === "delete"
                  ? remove()
                  : act("discard", "Couldn't discard it")
              }
            >
              {confirm === "delete" ? "Delete run" : "Discard"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
