"use client";

import { useSyncExternalStore } from "react";
import { isRed, type Run, type RunStatus, STATUS_LABEL } from "@/lib/workflows";
import { cn } from "@/lib/utils";

/**
 * Green ok, red failed, pulsing running, a grey dash for no changes, hollow
 * skipped, grey stopped.
 */
export function RunDot({
  status,
  className,
}: {
  status: RunStatus;
  className?: string;
}) {
  return (
    <span
      title={STATUS_LABEL[status]}
      className={cn("relative flex size-2 shrink-0", className)}
    >
      {status === "running" && (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-bolt opacity-75" />
      )}
      <span
        className={cn(
          "relative inline-flex size-full rounded-full",
          status === "nochange" && "h-0.5 self-center bg-muted-foreground/70",
          status === "ok" && "bg-emerald-500",
          isRed(status) && "bg-destructive",
          status === "running" && "bg-bolt",
          status === "cancelled" && "bg-muted-foreground/50",
          status === "skipped" && "border border-muted-foreground/60",
        )}
      />
    </span>
  );
}

/** Oldest to newest, left to right. */
export function RunStrip({
  runs,
  className,
}: {
  runs: Pick<Run, "id" | "status">[];
  className?: string;
}) {
  if (runs.length === 0) {
    return (
      <span className={cn("text-[11px] text-muted-foreground", className)}>
        no runs yet
      </span>
    );
  }
  return (
    <span className={cn("flex items-center gap-[3px]", className)}>
      {runs.map((r) => (
        <RunDot key={r.id} status={r.status} className="size-1.5" />
      ))}
    </span>
  );
}

// ── Time labels ──────────────────────────────────────────────────────────
// Relative to now, so only rendered on the client (null on the server keeps
// hydration clean) and refreshed every 30s.

function subscribeNow(cb: () => void) {
  const id = setInterval(cb, 30_000);
  return () => clearInterval(id);
}
const minute = () => Math.floor(Date.now() / 30_000) * 30_000;

export function useNow(): number | null {
  return useSyncExternalStore(subscribeNow, minute, () => null);
}

/** "in 9h", "in 12m", "in 2d". */
export function untilLabel(at: number, now: number) {
  const s = Math.max(0, (at - now) / 1000);
  if (s < 60) return "in <1m";
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86_400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86_400)}d`;
}

/** "Today 6:00 AM", "Yesterday 6:00 AM", "Sat 6:00 AM", "Oct 12 6:00 AM". */
export function whenLabel(iso: string, now: number) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day = (t: number) => new Date(t).toDateString();
  if (day(d.getTime()) === day(now)) return `Today ${time}`;
  if (day(d.getTime()) === day(now - 86_400_000)) return `Yesterday ${time}`;
  if (now - d.getTime() < 6 * 86_400_000) {
    return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
  }
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}
