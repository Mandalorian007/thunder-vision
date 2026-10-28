"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  cronToPreset,
  DAYS,
  DEFAULT_KEEP_RUNS,
  DEFAULT_TIMEOUT_MIN,
  describeSchedule,
  EFFORTS,
  type Effort,
  type Job,
  type JobSummary,
  MAX_KEEP_RUNS,
  MAX_TIMEOUT_MIN,
  MINUTE_STEPS,
  type Model,
  MODELS,
  type Preset,
  presetToCron,
  WEEKDAYS,
} from "@/lib/jobs";
import { cn } from "@/lib/utils";
import type { Dir } from "@/server/repos";

const field =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 pointer-coarse:h-10 pointer-coarse:text-base";

function Select<T extends string | number>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T;
  options: readonly (readonly [T, string])[];
  onChange(value: T): void;
  label: string;
  className?: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => {
        const raw = e.target.value;
        onChange((typeof value === "number" ? Number(raw) : raw) as T);
      }}
      className={cn(field, "appearance-auto pr-1", className)}
    >
      {options.map(([v, text]) => (
        <option key={v} value={v}>
          {text}
        </option>
      ))}
    </select>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

type Kind = Preset["kind"];
const KINDS: [Kind, string][] = [
  ["time", "At a time"],
  ["hourly", "Every hour"],
  ["minutes", "Every few minutes"],
  ["cron", "Custom (cron)"],
];

/** Switching kinds keeps the days and time you picked where it can. */
function switchKind(p: Preset, kind: Kind): Preset {
  if (kind === "cron") return { kind, cron: presetToCron(p) };
  const days = "days" in p ? p.days : WEEKDAYS;
  if (kind === "hourly") return { kind, minute: 0, days };
  if (kind === "minutes") return { kind, every: 15, days };
  return { kind, time: "time" in p ? p.time : "06:00", days };
}

/** S M T W T F S toggles; the last day on can't be turned off. */
function DayToggles({
  days,
  onChange,
}: {
  days: number[];
  onChange(days: number[]): void;
}) {
  return (
    <div role="group" aria-label="Days" className="flex gap-1">
      {DAYS.map((day, i) => {
        const on = days.includes(i);
        return (
          <button
            key={day}
            type="button"
            aria-label={day}
            aria-pressed={on}
            onClick={() =>
              onChange(
                on
                  ? days.length > 1
                    ? days.filter((d) => d !== i)
                    : days
                  : [...days, i].sort((a, b) => a - b),
              )
            }
            className="size-8 rounded-full border text-xs font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground pointer-coarse:size-10"
          >
            {day[0]}
          </button>
        );
      })}
    </div>
  );
}

type Draft = {
  name: string;
  dir: string;
  kind: "claude" | "shell";
  prompt: string;
  command: string;
  model: Model;
  effort: Effort;
  preset: Preset;
  timeoutMin: string;
  keepRuns: string;
};

function draftFrom(job: Job | null): Draft {
  const t = job?.task;
  return {
    name: job?.name ?? "",
    dir: job?.dir ?? "",
    kind: t?.kind ?? "claude",
    prompt: t?.kind === "claude" ? t.prompt : "",
    command: t?.kind === "shell" ? t.command : "",
    model: t?.kind === "claude" ? t.model : "sonnet",
    effort: t?.kind === "claude" ? t.effort : "medium",
    preset: job
      ? cronToPreset(job.schedule)
      : { kind: "time", time: "06:00", days: WEEKDAYS },
    timeoutMin: String(job?.timeoutMin ?? DEFAULT_TIMEOUT_MIN),
    keepRuns: String(job?.keepRuns ?? DEFAULT_KEEP_RUNS),
  };
}

/** New job (job null) or edit one. */
export function JobDialog({
  open,
  job,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  job: Job | null;
  onOpenChange(open: boolean): void;
  onSaved(id: string, jobs: JobSummary[]): void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        onCloseAutoFocus={(e) => e.preventDefault()}
        className="top-[max(1rem,6dvh)] max-h-[calc(100dvh-2rem)] translate-y-0 overflow-y-auto sm:max-w-lg"
      >
        {open && (
          <JobForm
            key={job?.id ?? "new"}
            job={job}
            onCancel={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function JobForm({
  job,
  onCancel,
  onSaved,
}: {
  job: Job | null;
  onCancel(): void;
  onSaved(id: string, jobs: JobSummary[]): void;
}) {
  const [d, setD] = useState(() => draftFrom(job));
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirs, setDirs] = useState<Dir[]>([]);
  const listId = useId();
  const set = (patch: Partial<Draft>) =>
    setD((prev) => ({ ...prev, ...patch }));

  useEffect(() => {
    fetch("/api/dirs")
      .then((r) => (r.ok ? r.json() : []))
      .then(setDirs, () => {});
  }, []);

  const cron = presetToCron(d.preset);
  const p = d.preset;

  const submit = async () => {
    setBusy(true);
    try {
      const fields = {
        name: d.name,
        dir: d.dir,
        schedule: cron,
        timeoutMin: Number(d.timeoutMin),
        keepRuns: Number(d.keepRuns),
        task:
          d.kind === "claude"
            ? {
                kind: "claude",
                prompt: d.prompt,
                model: d.model,
                effort: d.effort,
              }
            : { kind: "shell", command: d.command },
      };
      const res = await fetch("/api/jobs", {
        method: job ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(job ? { id: job.id, ...fields } : fields),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      onSaved(job?.id ?? data.id, data.jobs);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save the job");
      setBusy(false);
    }
  };

  const mono = "font-mono pointer-coarse:text-base";
  const time = (value: string) => (
    <Input
      type="time"
      aria-label="Time"
      required
      value={value}
      onChange={(e) =>
        set({ preset: { ...p, time: e.target.value } as Preset })
      }
      className="w-32 pointer-coarse:h-10 pointer-coarse:text-base"
    />
  );

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>{job ? "Edit job" : "New scheduled job"}</DialogTitle>
        <DialogDescription>
          Runs in the background on this Mac, with or without a browser open.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <Input
            autoFocus={!job}
            required
            value={d.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Morning triage"
            className="pointer-coarse:h-10 pointer-coarse:text-base"
          />
        </Field>
        <Field label="Folder">
          <Input
            required
            list={listId}
            value={d.dir}
            onChange={(e) => set({ dir: e.target.value })}
            placeholder="my-app or ~/path"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className={cn(mono, "pointer-coarse:h-10")}
          />
          <datalist id={listId}>
            {/* TV_ROOT itself too, as its path: runs across all repos. */}
            {dirs.map((x) => (
              <option key={x.rel} value={x.rel || x.path}>
                {x.rel ? x.path : "all repos"}
              </option>
            ))}
          </datalist>
        </Field>
      </div>

      <div className="flex flex-col gap-1.5">
        <div
          role="radiogroup"
          aria-label="Runs"
          className="inline-flex w-fit rounded-lg border p-0.5"
        >
          {(
            [
              ["claude", "Claude"],
              ["shell", "Shell"],
            ] as const
          ).map(([k, text]) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={d.kind === k}
              onClick={() => set({ kind: k })}
              className="rounded-md px-3 py-1 text-sm text-muted-foreground aria-checked:bg-secondary aria-checked:text-foreground pointer-coarse:px-4 pointer-coarse:py-2"
            >
              {text}
            </button>
          ))}
        </div>
        {d.kind === "claude" ? (
          <Field
            label="Prompt"
            hint={
              <>
                Runs <span className="font-mono">claude -p</span> in auto mode.
                A custom slash command like{" "}
                <span className="font-mono">/my-workflow</span> works well.
              </>
            }
          >
            <Textarea
              required
              value={d.prompt}
              onChange={(e) => set({ prompt: e.target.value })}
              placeholder="/my-workflow"
              spellCheck={false}
              rows={3}
              className={cn(mono, "max-h-60")}
            />
          </Field>
        ) : (
          <Field
            label="Command"
            hint="Runs in your login shell, in the folder above."
          >
            <Textarea
              required
              value={d.command}
              onChange={(e) => set({ command: e.target.value })}
              placeholder="pnpm test"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              rows={2}
              className={cn(mono, "max-h-60")}
            />
          </Field>
        )}
      </div>

      <Field
        label="When"
        hint={p.kind === "cron" ? null : describeSchedule(cron)}
      >
        <div className="flex flex-wrap gap-2">
          <Select
            label="Repeat"
            value={p.kind}
            options={KINDS}
            onChange={(kind) => set({ preset: switchKind(p, kind) })}
            className="w-auto"
          />
          {p.kind === "time" && time(p.time)}
          {p.kind === "minutes" && (
            <Select
              label="Every"
              value={p.every}
              options={MINUTE_STEPS.map((n) => [n, `every ${n} min`] as const)}
              onChange={(every) => set({ preset: { ...p, every } })}
              className="w-36"
            />
          )}
          {p.kind === "hourly" && (
            <Select
              label="Minute"
              value={p.minute}
              options={Array.from({ length: 12 }, (_, i) => {
                const m = i * 5;
                return [m, `at :${String(m).padStart(2, "0")}`] as const;
              })}
              onChange={(minute) => set({ preset: { ...p, minute } })}
              className="w-28"
            />
          )}
          {p.kind === "cron" && (
            <Input
              required
              aria-label="Cron"
              value={p.cron}
              onChange={(e) =>
                set({ preset: { kind: "cron", cron: e.target.value } })
              }
              placeholder="0 6 * * 1-5"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className={cn(mono, "w-44 pointer-coarse:h-10")}
            />
          )}
        </div>
        {"days" in p && (
          <DayToggles
            days={p.days}
            onChange={(days) => set({ preset: { ...p, days } })}
          />
        )}
        {p.kind === "cron" && (
          <span className="text-xs text-muted-foreground">
            minute hour day month weekday, in this Mac&apos;s time zone
          </span>
        )}
      </Field>

      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => setMore(!more)}
          aria-expanded={more}
          className="flex w-fit items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground pointer-coarse:py-1"
        >
          {more ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
          More options
          {!more && (
            <span className="font-normal">
              {" · "}
              {d.kind === "claude" ? `${d.model}, ${d.effort} effort, ` : ""}
              {d.timeoutMin}m timeout
            </span>
          )}
        </button>
        {more && (
          <div className="grid grid-cols-2 gap-3">
            {d.kind === "claude" && (
              <>
                <Field label="Model">
                  <Select
                    label="Model"
                    value={d.model}
                    options={MODELS.map((m) => [m, m] as const)}
                    onChange={(model) => set({ model })}
                  />
                </Field>
                <Field label="Effort">
                  <Select
                    label="Effort"
                    value={d.effort}
                    options={EFFORTS.map((e) => [e, e] as const)}
                    onChange={(effort) => set({ effort })}
                  />
                </Field>
              </>
            )}
            <Field label="Timeout (minutes)" hint="Stopped after this long.">
              <Input
                type="number"
                inputMode="numeric"
                required
                min={1}
                max={MAX_TIMEOUT_MIN}
                value={d.timeoutMin}
                onChange={(e) => set({ timeoutMin: e.target.value })}
                className="pointer-coarse:h-10 pointer-coarse:text-base"
              />
            </Field>
            <Field label="Keep runs" hint="Older runs are deleted.">
              <Input
                type="number"
                inputMode="numeric"
                required
                min={1}
                max={MAX_KEEP_RUNS}
                value={d.keepRuns}
                onChange={(e) => set({ keepRuns: e.target.value })}
                className="pointer-coarse:h-10 pointer-coarse:text-base"
              />
            </Field>
          </div>
        )}
      </div>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          className="pointer-coarse:h-10"
        >
          Cancel
        </Button>
        <Button type="submit" disabled={busy} className="pointer-coarse:h-10">
          {job ? "Save" : "Create job"}
        </Button>
      </DialogFooter>
    </form>
  );
}
