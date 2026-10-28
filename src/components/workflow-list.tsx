"use client";

import { GitPullRequest, Plus, Workflow } from "lucide-react";
import { IconButton } from "@/components/icon-button";
import { RunDot, RunStrip, untilLabel, useNow } from "@/components/run-dots";
import { SidebarSection } from "@/components/sidebar-section";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  describeSchedule,
  prLabel,
  type WorkflowSummary,
} from "@/lib/workflows";
import { cn } from "@/lib/utils";

/** "my-app", or a local workflow's folder. */
export const whereLabel = (w: WorkflowSummary) => w.repo ?? w.dir;

/** Right of the name: the step it's on, the next run, manual or paused. */
function nextLabel(w: WorkflowSummary, now: number | null) {
  if (w.progress) return `${w.progress.step + 1}/${w.progress.of}`;
  if (w.error) return "invalid";
  if (!w.schedule) return "manual";
  if (!w.enabled) return "paused";
  return w.nextRunAt && now !== null ? untilLabel(w.nextRunAt, now) : "";
}

/** The sidebar's Workflows section: name, where, next run, the last runs. */
export function WorkflowList({
  workflows,
  active,
  onSelect,
  onNew,
  collapsed = false,
}: {
  workflows: WorkflowSummary[];
  active: string | null;
  onSelect(id: string): void;
  onNew(): void;
  collapsed?: boolean;
}) {
  const now = useNow();

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1 border-t border-sidebar-border pt-2">
        {workflows.map((w) => {
          const last = w.recent.at(-1);
          return (
            <Tooltip key={w.id}>
              <TooltipTrigger asChild>
                <button
                  aria-label={w.name}
                  aria-current={w.id === active}
                  onClick={() => onSelect(w.id)}
                  className={cn(
                    "relative flex size-10 shrink-0 items-center justify-center rounded-md transition-colors",
                    w.id === active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-primary/50"
                      : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                    w.schedule && !w.enabled && "opacity-50",
                  )}
                >
                  <Workflow className="size-4" />
                  {last && (
                    <span className="absolute top-1 right-1">
                      <RunDot status={last.status} />
                    </span>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" className="text-xs">
                <div className="space-y-1">
                  <div className="font-semibold">{w.name}</div>
                  <div className="opacity-70">
                    {whereLabel(w)} · {describeSchedule(w.schedule)}
                    {w.schedule &&
                      nextLabel(w, now) &&
                      ` · ${nextLabel(w, now)}`}
                  </div>
                  {w.recent.length > 0 && <RunStrip runs={w.recent} />}
                </div>
              </TooltipContent>
            </Tooltip>
          );
        })}
        <IconButton
          label="New workflow"
          side="right"
          onClick={onNew}
          className="size-10 shrink-0 border border-dashed border-sidebar-border"
        >
          <Workflow />
        </IconButton>
      </div>
    );
  }

  return (
    <SidebarSection
      id="workflows"
      title="Workflows"
      count={workflows.length}
      action={
        <IconButton label="New workflow" onClick={onNew} className="size-7">
          <Plus />
        </IconButton>
      }
    >
      <ul className="flex flex-col gap-px px-2 pb-2">
        {workflows.length === 0 && (
          <li>
            <button
              onClick={onNew}
              className="w-full rounded-md px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground pointer-coarse:py-2.5"
            >
              Chain shell steps and Claude, by hand or on a schedule.
            </button>
          </li>
        )}
        {workflows.map((w) => {
          const selected = w.id === active;
          const label = nextLabel(w, now);
          const dim = !!w.error || (!!w.schedule && !w.enabled);
          return (
            <li key={w.id}>
              <button
                aria-current={selected}
                onClick={() => onSelect(w.id)}
                className={cn(
                  "relative flex w-full flex-col gap-0.5 rounded-md py-1 pr-2.5 pl-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:py-2",
                  selected
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/75 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                )}
              >
                {selected && (
                  <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary" />
                )}
                <span className="flex w-full items-center gap-2">
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-[13px] leading-5",
                      dim && "text-muted-foreground",
                    )}
                  >
                    {w.name}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-[11px] tabular-nums",
                      w.progress
                        ? "text-bolt"
                        : w.error
                          ? "text-destructive"
                          : "text-muted-foreground",
                    )}
                  >
                    {label}
                  </span>
                </span>
                <span className="flex w-full items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {whereLabel(w)}
                  </span>
                  {w.progress && (
                    <span className="max-w-[45%] shrink-0 truncate text-bolt">
                      {w.progress.id}
                    </span>
                  )}
                </span>
                <span className="flex w-full items-center gap-2">
                  <RunStrip runs={w.recent} className="min-w-0" />
                  {w.lastPr && (
                    <span className="ml-auto flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground">
                      <GitPullRequest className="size-3" />
                      {prLabel(w.lastPr).replace(/^PR /, "")}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </SidebarSection>
  );
}
