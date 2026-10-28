"use client";

import { Ellipsis, Pencil, Plus, Skull, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton, type TooltipSide } from "@/components/icon-button";
import { SidebarSection } from "@/components/sidebar-section";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { TmuxSession } from "@/server/tmux";

/** Output in the last few seconds usually means Claude is mid-turn. */
export const BUSY_SECONDS = 5;

function idleLabel(seconds: number) {
  if (seconds < BUSY_SECONDS) return "now";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/** "thunder-vision" → "tv", "thunder" → "th": rail labels. */
function abbrev(name: string) {
  const parts = name.split(/[-_.\s]+/).filter(Boolean);
  return parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
}

export function StatusDot({
  busy,
  selected,
}: {
  busy: boolean;
  selected: boolean;
}) {
  return (
    <span className="relative flex size-2 shrink-0">
      {busy && (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-bolt opacity-75" />
      )}
      <span
        className={cn(
          "relative inline-flex size-2 rounded-full",
          busy ? "bg-bolt" : selected ? "bg-primary" : "bg-muted-foreground/40",
        )}
      />
    </span>
  );
}

type Props = {
  sessions: TmuxSession[];
  active: string | null;
  onSelect(name: string): void;
  onNew(): void;
  /** Opens the rename or kill dialog; nothing changes yet. */
  onAction: OnAction;
  /** Icon rail instead of the full list. */
  collapsed?: boolean;
  /** Header buttons: a row beside the title, or a column when collapsed. */
  controls(side: TooltipSide): ReactNode;
  /** Pinned below the tabs (plan usage). */
  footer?: ReactNode;
  /** Below the tabs, scrolling with them (scheduled jobs). */
  jobs?: ReactNode;
};

export function SessionSidebar({
  sessions,
  active,
  onSelect,
  onNew,
  onAction,
  collapsed = false,
  controls,
  footer,
  jobs,
}: Props) {
  const zap = (
    <Zap className="size-5 shrink-0 fill-bolt text-bolt drop-shadow-[0_0_6px_var(--bolt)]" />
  );
  const tabs = (
    <nav
      role="tablist"
      aria-label="tmux sessions"
      aria-orientation="vertical"
      className={cn(
        "flex flex-col gap-px px-2 pb-1",
        collapsed && "items-center gap-1",
      )}
    >
      {sessions.map((s, i) => {
        const tab = {
          session: s,
          index: i,
          selected: s.name === active,
          onSelect,
        };
        return (
          <SessionMenu key={s.name} name={s.name} onAction={onAction}>
            {collapsed ? (
              <RailTab {...tab} />
            ) : (
              <SessionTab {...tab} onAction={onAction} />
            )}
          </SessionMenu>
        );
      })}
      {collapsed && (
        <IconButton
          label="New session  ⌘K"
          side="right"
          onClick={onNew}
          className="size-10 shrink-0 border border-dashed border-sidebar-border"
        >
          <Plus />
        </IconButton>
      )}
    </nav>
  );
  return (
    <div className="flex h-full flex-col">
      {collapsed ? (
        <div className="flex shrink-0 flex-col items-center gap-1 pt-3.5 pb-2">
          <div className="mb-1.5">{zap}</div>
          {controls("right")}
        </div>
      ) : (
        <div className="flex h-12 shrink-0 items-center gap-2 pr-2 pl-4">
          {zap}
          <span className="text-sm font-semibold tracking-tight">
            Thunder Vision
          </span>
          <div className="ml-auto flex items-center gap-0.5">
            {controls("bottom")}
          </div>
        </div>
      )}

      <div
        className={cn(
          "min-h-0 flex-1 overscroll-contain overflow-y-auto [scrollbar-width:thin]",
          collapsed && "pb-2",
        )}
      >
        {collapsed ? (
          tabs
        ) : (
          <SidebarSection
            id="sessions"
            title="Sessions"
            count={sessions.length}
            action={
              <IconButton
                label="New session  ⌘K"
                onClick={onNew}
                className="size-7"
              >
                <Plus />
              </IconButton>
            }
          >
            {tabs}
          </SidebarSection>
        )}
        {jobs}
      </div>

      {footer && (
        <div className="flex shrink-0 justify-center border-t border-sidebar-border p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {footer}
        </div>
      )}
    </div>
  );
}

export type SessionAction = "rename" | "kill";
type OnAction = (action: SessionAction, name: string) => void;

/** Right-click, or long-press on touch. iOS's own callout would win otherwise. */
function SessionMenu({
  name,
  onAction,
  children,
}: {
  name: string;
  onAction: OnAction;
  children: ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-44">
        <div className="truncate px-1.5 py-1 font-mono text-xs text-muted-foreground">
          {name}
        </div>
        <ContextMenuItem
          onSelect={() => onAction("rename", name)}
          className="pointer-coarse:py-2.5"
        >
          <Pencil /> Rename…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          onSelect={() => onAction("kill", name)}
          className="pointer-coarse:py-2.5"
        >
          <Skull /> Kill session…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

type TabProps = {
  session: TmuxSession;
  index: number;
  selected: boolean;
  onSelect(name: string): void;
};

function SessionTab({
  session: s,
  index,
  selected,
  onSelect,
  onAction,
  ...menuProps
}: TabProps & { onAction: OnAction }) {
  const busy = s.idleSeconds < BUSY_SECONDS;
  return (
    // menuProps: ContextMenuTrigger's handlers land on this row.
    <div
      {...menuProps}
      className={cn(
        "group relative flex w-full items-center rounded-md transition-colors select-none [-webkit-touch-callout:none]",
        selected
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground/75 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
      )}
    >
      {selected && (
        <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary" />
      )}
      <button
        role="tab"
        aria-selected={selected}
        onClick={() => onSelect(s.name)}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md py-1 pl-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:py-2"
      >
        <StatusDot busy={busy} selected={selected} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[13px] leading-5">
            {s.name}
          </span>
          <span className="block truncate text-[11px] leading-4 text-muted-foreground">
            {s.path}
          </span>
        </span>
        <span
          className={cn(
            "shrink-0 text-[11px] tabular-nums",
            busy ? "text-bolt" : "text-muted-foreground",
            index < 9 && "group-hover:hidden",
          )}
        >
          {idleLabel(s.idleSeconds)}
        </span>
        {index < 9 && (
          <Kbd className="hidden group-hover:inline-flex">⌥{index + 1}</Kbd>
        )}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label={`Actions for ${s.name}`}
            // Hover-only with a mouse; always there on touch, where hover isn't.
            className="mx-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none group-hover:opacity-100 hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:opacity-100 pointer-coarse:size-9 pointer-coarse:opacity-100 [&_svg]:size-4"
          >
            <Ellipsis />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuItem
            onSelect={() => onAction("rename", s.name)}
            className="pointer-coarse:py-2.5"
          >
            <Pencil /> Rename…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => onAction("kill", s.name)}
            className="pointer-coarse:py-2.5"
          >
            <Skull /> Kill session…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function RailTab({
  session: s,
  index,
  selected,
  onSelect,
  ...menuProps
}: TabProps) {
  const busy = s.idleSeconds < BUSY_SECONDS;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          {...menuProps}
          role="tab"
          aria-selected={selected}
          aria-label={s.name}
          onClick={() => onSelect(s.name)}
          className={cn(
            "relative flex size-10 shrink-0 items-center justify-center rounded-md font-mono text-xs font-semibold uppercase transition-colors select-none [-webkit-touch-callout:none]",
            selected
              ? "bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-primary/50"
              : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
          )}
        >
          {abbrev(s.name)}
          <span className="absolute top-1 right-1">
            <StatusDot busy={busy} selected={selected} />
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="font-mono text-xs">
        <div className="space-y-0.5">
          <div className="font-semibold">{s.name}</div>
          <div className="opacity-70">{s.path}</div>
          <div className="opacity-70">
            {busy ? "active now" : `idle ${idleLabel(s.idleSeconds)}`} ·{" "}
            {s.windows} window{s.windows === 1 ? "" : "s"}
          </div>
          {index < 9 && (
            <div className="pt-1 opacity-70">
              <Kbd>⌥{index + 1}</Kbd>
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
