"use client";

import { RotateCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { subscribe } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import type { Usage, UsageWindow } from "@/server/usage";

/**
 * Cheap: the server answers from its hourly check. Keeps the reset countdowns
 * moving and drops a window to 0% soon after it resets.
 */
const POLL_MS = 30_000;

/** The last numbers this device saw, so a reload shows them straight away. */
const CACHE_KEY = "tv:usage";

function readCache() {
  try {
    return localStorage.getItem(CACHE_KEY);
  } catch {
    return null;
  }
}

function parseCache(raw: string | null): Usage | null {
  try {
    const u = JSON.parse(raw ?? "null");
    return typeof u?.updatedAt === "number" ? u : null;
  } catch {
    return null;
  }
}

/**
 * Plan usage; undefined until the first answer, null if unavailable.
 * `refresh` asks the server to check now; the next check is still on the hour.
 */
export function useUsage() {
  const [fetched, setFetched] = useState<Usage | null | undefined>(undefined);
  const cacheRaw = useSyncExternalStore(subscribe, readCache, () => null);
  const cached = useMemo(() => parseCache(cacheRaw), [cacheRaw]);
  const [refreshing, setRefreshing] = useState(false);
  // Only ever replaced by numbers at least as new: a failed check, a server
  // that just restarted or an empty answer leaves what's shown alone.
  const setUsage = useCallback((next: Usage | null) => {
    setFetched((prev) => {
      if (!next) return prev ?? null;
      if (prev && prev.updatedAt > next.updatedAt) return prev;
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);
  const usage =
    fetched && cached && cached.updatedAt > fetched.updatedAt
      ? cached
      : (fetched ?? cached ?? fetched);
  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      try {
        const res = await fetch("/api/usage", { cache: "no-store" });
        const next = res.ok ? await res.json() : null;
        if (!stopped) setUsage(next);
      } catch {}
    };
    refresh();
    const id = setInterval(refresh, POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [setUsage]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/usage", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next: Usage | null = await res.json();
      setUsage(next);
      // The server keeps the last good numbers when a check fails.
      if (!next || Date.now() - next.updatedAt > 60_000) {
        toast.error("Couldn't get fresh usage from Claude Code");
      }
    } catch {
      toast.error("Couldn't check usage");
    } finally {
      setRefreshing(false);
    }
  }, [setUsage]);

  return { usage, refresh, refreshing };
}

const tone = (pct: number) =>
  pct >= 90 ? "destructive" : pct >= 75 ? "bolt" : "primary";

function duration(ms: number) {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

function resetLabel(resetsAt: number, weekly: boolean) {
  if (!resetsAt) return null;
  const left = resetsAt - Date.now();
  if (left <= 0) return "reset";
  if (!weekly || left < 86_400_000) return `resets in ${duration(left)}`;
  const at = new Date(resetsAt).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  return `resets ${at}`;
}

type Row = { label: string; window: UsageWindow; weekly: boolean };

function rows(usage: Usage): Row[] {
  const out: Row[] = [];
  if (usage.session)
    out.push({ label: "Session", window: usage.session, weekly: false });
  if (usage.week) out.push({ label: "Week", window: usage.week, weekly: true });
  return out;
}

function checkedLabel(usage: Usage) {
  const ago = Date.now() - usage.updatedAt;
  return ago < 60_000 ? "checked just now" : `checked ${duration(ago)} ago`;
}

/** Checks run hourly, so older than that means they're failing. */
const isStale = (usage: Usage) => Date.now() - usage.updatedAt > 70 * 60_000;

/**
 * Ultra (formerly Max 20x) has no 5-hour window, but Claude Code still
 * reports it as "max"; a Max login with only the weekly cap is Ultra.
 */
const planName = (usage: Usage) =>
  usage.plan === "max" && !usage.session && usage.week ? "ultra" : usage.plan;

/** "max" → "Max plan", "ultra" → "Ultra plan". */
const planLabel = (usage: Usage) => {
  const plan = planName(usage);
  return plan ? `${plan[0].toUpperCase()}${plan.slice(1)} plan` : "Plan usage";
};

/** Session (5-hour) and weekly plan caps, as /usage shows them. */
export function UsageMeters({
  usage,
  collapsed = false,
  onRefresh,
  refreshing = false,
}: {
  usage: Usage | null | undefined;
  collapsed?: boolean;
  onRefresh?(): void;
  refreshing?: boolean;
}) {
  const list = usage ? rows(usage) : [];

  if (collapsed) {
    if (!usage || list.length === 0) return null;
    return (
      <div className="flex flex-col items-center gap-1.5">
        {list.map((r) => (
          <Tooltip key={r.label}>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                aria-label={`${r.label} usage ${Math.round(r.window.usedPercentage)}%`}
              >
                <Ring pct={r.window.usedPercentage} />
              </span>
            </TooltipTrigger>
            <TooltipContent side="right">
              {r.label} {Math.round(r.window.usedPercentage)}%{" · "}
              {resetLabel(r.window.resetsAt, r.weekly)}
              <div className="opacity-70">
                {[planLabel(usage), usage.email, checkedLabel(usage)]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-2 px-2 py-1">
      <div className="flex min-w-0 flex-col">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="min-w-0 flex-1 truncate font-medium tracking-wider uppercase">
            {usage ? planLabel(usage) : "Plan usage"}
          </span>
          {usage && (
            <span
              className={cn(
                "shrink-0 opacity-70",
                isStale(usage) && "text-bolt opacity-100",
              )}
            >
              {checkedLabel(usage)}
            </span>
          )}
          {onRefresh && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Check usage now"
                  disabled={refreshing || usage === undefined}
                  onClick={onRefresh}
                  // Sits in the header row without making it taller.
                  className="-my-1.5 -mr-1.5 size-6 shrink-0 text-muted-foreground pointer-coarse:size-8"
                >
                  <RotateCw
                    className={cn("size-3.5", refreshing && "animate-spin")}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Check now</TooltipContent>
            </Tooltip>
          )}
        </div>
        {usage?.email && (
          <span
            className="truncate text-xs text-muted-foreground"
            title={usage.email}
          >
            {usage.email}
          </span>
        )}
      </div>
      {list.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {usage === undefined
            ? "Checking…"
            : usage
              ? "No plan limits on this login."
              : "Couldn't get usage from Claude Code."}
        </p>
      ) : (
        list.map((r) => <Bar key={r.label} {...r} />)
      )}
    </div>
  );
}

function Bar({ label, window: w, weekly }: Row) {
  const pct = Math.min(100, Math.max(0, w.usedPercentage));
  const t = tone(pct);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="font-medium">{label}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {resetLabel(w.resetsAt, weekly)}
        </span>
        <span
          className={cn(
            "font-mono tabular-nums",
            t === "destructive" && "text-destructive",
            t === "bolt" && "text-bolt",
          )}
        >
          {Math.round(pct)}%
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${label} usage`}
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            t === "destructive"
              ? "bg-destructive"
              : t === "bolt"
                ? "bg-bolt"
                : "bg-primary",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function Ring({ pct }: { pct: number }) {
  const p = Math.min(100, Math.max(0, pct));
  const r = 13;
  const c = 2 * Math.PI * r;
  const t = tone(p);
  return (
    <svg viewBox="0 0 32 32" className="size-9" aria-hidden>
      <circle
        cx="16"
        cy="16"
        r={r}
        fill="none"
        strokeWidth="3"
        className="stroke-muted"
      />
      <circle
        cx="16"
        cy="16"
        r={r}
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - p / 100)}
        transform="rotate(-90 16 16)"
        className={cn(
          t === "destructive"
            ? "stroke-destructive"
            : t === "bolt"
              ? "stroke-bolt"
              : "stroke-primary",
        )}
      />
      <text
        x="16"
        y="16"
        dominantBaseline="central"
        textAnchor="middle"
        className="fill-foreground font-mono text-[9px]"
      >
        {Math.round(p)}
      </text>
    </svg>
  );
}
