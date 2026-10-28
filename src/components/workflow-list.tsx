"use client";

import { GitPullRequest, Plus, Workflow } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { IconButton } from "@/components/icon-button";
import { RunDot, RunStrip, untilLabel, useNow } from "@/components/run-dots";
import { SidebarSection } from "@/components/sidebar-section";
import {
  Grip,
  MoveItems,
  moved,
  type RefCallback,
  SortableList,
  useSortableRow,
} from "@/components/sortable";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
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
  onReorder,
  collapsed = false,
}: {
  workflows: WorkflowSummary[];
  active: string | null;
  onSelect(id: string): void;
  onNew(): void;
  /** Every workflow's id, in the order dragged to. */
  onReorder(ids: string[]): void;
  collapsed?: boolean;
}) {
  const now = useNow();
  const ids = workflows.map((w) => w.id);
  const menu = (w: WorkflowSummary, index: number) => ({
    name: w.name,
    index,
    count: workflows.length,
    onMove: (by: -1 | 1) => {
      const next = moved(ids, w.id, by);
      if (next) onReorder(next);
    },
  });

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1 border-t border-sidebar-border pt-2">
        <SortableList ids={ids} onReorder={onReorder}>
          {workflows.map((w, i) => (
            <WorkflowMenu key={w.id} {...menu(w, i)}>
              <RailItem
                workflow={w}
                selected={w.id === active}
                now={now}
                onSelect={onSelect}
              />
            </WorkflowMenu>
          ))}
        </SortableList>
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
        <SortableList ids={ids} onReorder={onReorder}>
          {workflows.map((w, i) => (
            <WorkflowMenu key={w.id} {...menu(w, i)}>
              <Row
                workflow={w}
                selected={w.id === active}
                now={now}
                onSelect={onSelect}
              />
            </WorkflowMenu>
          ))}
        </SortableList>
      </ul>
    </SidebarSection>
  );
}

/** Right-click, or long-press on touch: Move up / Move down. */
function WorkflowMenu({
  name,
  index,
  count,
  onMove,
  children,
}: {
  name: string;
  index: number;
  count: number;
  onMove(by: -1 | 1): void;
  children: ReactNode;
}) {
  if (count < 2) return children;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-44">
        <div className="truncate px-1.5 py-1 text-xs text-muted-foreground">
          {name}
        </div>
        <MoveItems
          Item={ContextMenuItem}
          index={index}
          count={count}
          onMove={onMove}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

type ItemProps = {
  workflow: WorkflowSummary;
  selected: boolean;
  now: number | null;
  onSelect(id: string): void;
  // From ContextMenuTrigger, which hands its handlers to the row.
  ref?: RefCallback;
  style?: CSSProperties;
};

function RailItem({
  workflow: w,
  selected,
  now,
  onSelect,
  ref,
  style,
  ...menuProps
}: ItemProps) {
  const { row } = useSortableRow(w.id, ref);
  const last = w.recent.at(-1);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          {...menuProps}
          {...row}
          style={{ ...style, ...row.style }}
          aria-label={w.name}
          aria-current={selected}
          onClick={() => onSelect(w.id)}
          className={cn(
            "relative flex size-10 shrink-0 items-center justify-center rounded-md transition-colors select-none [-webkit-touch-callout:none] data-dragging:z-20 data-dragging:bg-sidebar-accent data-dragging:shadow-md",
            selected
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
            {w.schedule && nextLabel(w, now) && ` · ${nextLabel(w, now)}`}
          </div>
          {w.recent.length > 0 && <RunStrip runs={w.recent} />}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function Row({
  workflow: w,
  selected,
  now,
  onSelect,
  ref,
  style,
  ...menuProps
}: ItemProps) {
  const { row, grip } = useSortableRow(w.id, ref);
  const label = nextLabel(w, now);
  const dim = !!w.error || (!!w.schedule && !w.enabled);
  return (
    <li
      {...menuProps}
      {...row}
      style={{ ...style, ...row.style }}
      className="relative flex rounded-md select-none [-webkit-touch-callout:none] data-dragging:z-20 data-dragging:bg-sidebar-accent data-dragging:shadow-md"
    >
      <Grip {...grip} className="-mr-2" />
      <button
        aria-current={selected}
        onClick={() => onSelect(w.id)}
        className={cn(
          "relative flex min-w-0 flex-1 flex-col gap-0.5 rounded-md py-1 pr-2.5 pl-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:py-2",
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
}
