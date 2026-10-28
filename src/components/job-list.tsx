"use client";

import { CalendarClock, Plus } from "lucide-react";
import { IconButton } from "@/components/icon-button";
import { RunDot, RunStrip, untilLabel, useNow } from "@/components/run-dots";
import { SidebarSection } from "@/components/sidebar-section";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { describeSchedule, type JobSummary } from "@/lib/jobs";
import { cn } from "@/lib/utils";

/** The sidebar's Jobs section: name, next run, and the last runs as dots. */
export function JobList({
  jobs,
  active,
  onSelect,
  onNew,
  collapsed = false,
}: {
  jobs: JobSummary[];
  active: string | null;
  onSelect(id: string): void;
  onNew(): void;
  collapsed?: boolean;
}) {
  const now = useNow();
  const next = (j: JobSummary) =>
    !j.enabled
      ? "paused"
      : j.recent.at(-1)?.status === "running"
        ? "running"
        : j.nextRunAt && now !== null
          ? untilLabel(j.nextRunAt, now)
          : "";

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1 border-t border-sidebar-border pt-2">
        {jobs.map((j) => {
          const last = j.recent.at(-1);
          return (
            <Tooltip key={j.id}>
              <TooltipTrigger asChild>
                <button
                  aria-label={j.name}
                  aria-current={j.id === active}
                  onClick={() => onSelect(j.id)}
                  className={cn(
                    "relative flex size-10 shrink-0 items-center justify-center rounded-md transition-colors",
                    j.id === active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-primary/50"
                      : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                    !j.enabled && "opacity-50",
                  )}
                >
                  <CalendarClock className="size-4" />
                  {last && (
                    <span className="absolute top-1 right-1">
                      <RunDot status={last.status} />
                    </span>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" className="text-xs">
                <div className="space-y-1">
                  <div className="font-semibold">{j.name}</div>
                  <div className="opacity-70">
                    {describeSchedule(j.schedule)}
                    {next(j) && ` · ${next(j)}`}
                  </div>
                  {j.recent.length > 0 && <RunStrip runs={j.recent} />}
                </div>
              </TooltipContent>
            </Tooltip>
          );
        })}
        <IconButton
          label="New job"
          side="right"
          onClick={onNew}
          className="size-10 shrink-0 border border-dashed border-sidebar-border"
        >
          <CalendarClock />
        </IconButton>
      </div>
    );
  }

  return (
    <SidebarSection
      id="jobs"
      title="Scheduled Jobs"
      count={jobs.length}
      action={
        <IconButton label="New job" onClick={onNew} className="size-7">
          <Plus />
        </IconButton>
      }
    >
      <ul className="flex flex-col gap-px px-2 pb-2">
        {jobs.length === 0 && (
          <li>
            <button
              onClick={onNew}
              className="w-full rounded-md px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground pointer-coarse:py-2.5"
            >
              Run Claude or a command on a schedule.
            </button>
          </li>
        )}
        {jobs.map((j) => {
          const selected = j.id === active;
          return (
            <li key={j.id}>
              <button
                aria-current={selected}
                onClick={() => onSelect(j.id)}
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
                      !j.enabled && "text-muted-foreground",
                    )}
                  >
                    {j.name}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-[11px] tabular-nums",
                      next(j) === "running"
                        ? "text-bolt"
                        : "text-muted-foreground",
                    )}
                  >
                    {next(j)}
                  </span>
                </span>
                <RunStrip runs={j.recent} />
              </button>
            </li>
          );
        })}
      </ul>
    </SidebarSection>
  );
}
