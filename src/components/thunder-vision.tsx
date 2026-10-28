"use client";

import {
  Keyboard,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  TerminalSquare,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { toast } from "sonner";
import { IconButton, type TooltipSide } from "@/components/icon-button";
import { KeyBar } from "@/components/key-bar";
import { NewSessionPalette } from "@/components/new-session-palette";
import { RenameDialog } from "@/components/rename-dialog";
import {
  BUSY_SECONDS,
  type SessionAction,
  SessionSidebar,
  StatusDot,
} from "@/components/session-sidebar";
import { SettingsMenu } from "@/components/settings-menu";
import { TerminalPane, type PaneHandle } from "@/components/terminal-pane";
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
import { Kbd } from "@/components/ui/kbd";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { UsageMeters, useUsage } from "@/components/usage-meters";
import { cn } from "@/lib/utils";
import type { TmuxSession } from "@/server/tmux";

const POLL_MS = 2000;
const MIN_FONT = 9;
const MAX_FONT = 22;

// Tiny external stores so URL hash and localStorage prefs hydrate cleanly.
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("hashchange", listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("hashchange", listener);
    window.removeEventListener("storage", listener);
  };
}

function readHash() {
  const raw = window.location.hash.slice(1);
  return raw ? decodeURIComponent(raw) : null;
}

/** The selected session lives in the URL hash, so tabs are deep-linkable. */
function useHash() {
  return useSyncExternalStore(subscribe, readHash, () => null);
}

function setHash(name: string) {
  history.replaceState(null, "", `#${encodeURIComponent(name)}`);
  notify();
}

/** Per-device preference. Storage may be blocked (private mode), so never trust it. */
function usePref<T>(key: string, serverDefault: T, clientDefault: () => T) {
  const raw = useSyncExternalStore(
    subscribe,
    () => {
      try {
        const stored = localStorage.getItem(key);
        if (stored !== null) return stored;
      } catch {}
      return JSON.stringify(clientDefault());
    },
    () => JSON.stringify(serverDefault),
  );
  const set = useCallback(
    (next: T) => {
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {}
      notify();
    },
    [key],
  );
  return [JSON.parse(raw) as T, set] as const;
}

const isTouch = () => matchMedia("(pointer: coarse)").matches;

export function ThunderVision({
  initialSessions,
}: {
  initialSessions: TmuxSession[];
}) {
  const [sessions, setSessionsState] = useState(initialSessions);
  // Bumped on every update, so a poll that started before a create/kill
  // can't land afterwards and resurrect the old list.
  const sessionsVersion = useRef(0);
  const setSessions = useCallback((next: TmuxSession[]) => {
    sessionsVersion.current++;
    setSessionsState(next);
  }, []);
  // Panes stay mounted after first visit so switching tabs is instant.
  const [visited, setVisited] = useState<string[]>([]);
  const [ctrl, setCtrl] = useState(false);
  const ctrlRef = useRef(false);
  const panes = useRef(new Map<string, PaneHandle>());

  // Touch devices default to the key bar, and phones to smaller text.
  const [fontSize, setFontSize] = usePref<number>("tv:fontSize", 12, () =>
    isTouch() && innerWidth < 640 ? 11 : 12,
  );
  const [showKeys, setShowKeys] = usePref("tv:keybar", false, isTouch);
  const [collapsed, setCollapsed] = usePref(
    "tv:sidebarCollapsed",
    false,
    () => false,
  );
  // Below md the sidebar is a drawer instead.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Which rename/kill dialog is open. The target outlives `dialog` so the
  // text doesn't blank mid-animation.
  const [dialog, setDialog] = useState<SessionAction | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const {
    usage,
    refresh: refreshUsage,
    refreshing: refreshingUsage,
  } = useUsage();

  const names = sessions.map((s) => s.name);
  const hash = useHash();
  const active = hash && names.includes(hash) ? hash : (names[0] ?? null);
  const opened = names.filter((n) => n === active || visited.includes(n));

  const select = (name: string) => {
    setVisited((prev) => [
      ...new Set([...prev, name, ...(active ? [active] : [])]),
    ]);
    setHash(name);
  };

  // Poll tmux. New sessions appear as tabs; vanished ones drop their panes.
  // Also reloads the page after a server restart: a backgrounded tab (iOS
  // especially) misses the HMR update, and would otherwise show stale UI.
  useEffect(() => {
    let stopped = false;
    let boot: string | null = null;
    const refresh = async () => {
      const version = sessionsVersion.current;
      try {
        const res = await fetch("/api/sessions", { cache: "no-store" });
        const seen = res.headers.get("X-TV-Boot");
        if (boot && seen && seen !== boot) return location.reload();
        boot ??= seen;
        const next = res.ok ? await res.json() : null;
        if (next && !stopped && version === sessionsVersion.current) {
          setSessions(next);
        }
      } catch {}
    };
    const id = setInterval(refresh, POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [setSessions]);

  // ⌥1–⌥9 jumps to a tab, ⌘K opens the palette. Capture phase so they win
  // over the focused terminal. (Ctrl+K stays with the shell.)
  const onShortcut = useEffectEvent((e: KeyboardEvent) => {
    if (e.metaKey && !e.altKey && !e.ctrlKey && e.code === "KeyK") {
      e.preventDefault();
      e.stopPropagation();
      setPaletteOpen(true);
      return;
    }
    const match =
      e.altKey && !e.metaKey && !e.ctrlKey && /^Digit([1-9])$/.exec(e.code);
    if (!match) return;
    const target = sessions[Number(match[1]) - 1];
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    select(target.name);
  });
  useEffect(() => {
    window.addEventListener("keydown", onShortcut, true);
    return () => window.removeEventListener("keydown", onShortcut, true);
  }, []);

  // The drawer is hidden at md+, but its overlay would linger; close it.
  useEffect(() => {
    const wide = matchMedia("(min-width: 48rem)");
    const onChange = () => wide.matches && setDrawerOpen(false);
    wide.addEventListener("change", onChange);
    return () => wide.removeEventListener("change", onChange);
  }, []);

  const focusTerminal = () => {
    // Popping the keyboard on a phone is worse than one extra tap.
    if (active && !isTouch()) panes.current.get(active)?.focus();
  };

  const openPalette = () => {
    setDrawerOpen(false);
    setPaletteOpen(true);
  };

  const onAction = (action: SessionAction, name: string) => {
    setDrawerOpen(false);
    setTarget(name);
    setDialog(action);
  };

  const rename = async (from: string, to: string) => {
    try {
      const res = await fetch("/api/sessions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: from, to }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      // The pane remounts under the new name and reattaches.
      if (from === active) setHash(data.name);
      setSessions(data.sessions);
      setVisited((prev) => prev.map((n) => (n === from ? data.name : n)));
      setDialog(null);
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Couldn't rename`);
      return false;
    }
  };

  const kill = async (name: string) => {
    try {
      const res = await fetch("/api/sessions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      const next: TmuxSession[] = data.sessions;
      // Land on the neighbour, like closing a browser tab.
      if (name === active && next.length > 0) {
        const i = Math.min(names.indexOf(name), next.length - 1);
        setHash(next[Math.max(0, i)].name);
      }
      setSessions(next);
      setVisited((prev) => prev.filter((n) => n !== name));
      toast(`Killed ${name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Couldn't kill ${name}`);
    }
  };

  const register = useCallback((name: string, handle: PaneHandle | null) => {
    if (handle) panes.current.set(name, handle);
    else panes.current.delete(name);
  }, []);

  const setCtrlArmed = useCallback((armed: boolean) => {
    ctrlRef.current = armed;
    setCtrl(armed);
  }, []);

  const sendKey = (seq: string) => {
    if (!active) return;
    setCtrlArmed(false);
    panes.current.get(active)?.send(seq);
  };

  const bumpFont = (delta: number) =>
    setFontSize(Math.min(MAX_FONT, Math.max(MIN_FONT, fontSize + delta)));

  const keysButton = (side: TooltipSide) => (
    <IconButton
      side={side}
      label={showKeys ? "Hide key bar" : "Show key bar"}
      onClick={() => setShowKeys(!showKeys)}
      pressed={showKeys}
    >
      <Keyboard />
    </IconButton>
  );

  const controls = (side: TooltipSide, collapsible: boolean) => (
    <>
      <SettingsMenu
        side={side}
        fontSize={fontSize}
        onFontSize={bumpFont}
        showKeys={showKeys}
        onShowKeys={setShowKeys}
      />
      {collapsible && (
        <IconButton
          side={side}
          label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
        </IconButton>
      )}
    </>
  );

  // The rail has no room for the "shows up after…" hint.
  const hasUsage = !!(usage?.session || usage?.week);

  const activeSession = sessions.find((s) => s.name === active);
  const otherBusy = sessions.some(
    (s) => s.name !== active && s.idleSeconds < BUSY_SECONDS,
  );

  return (
    <div className="flex min-h-0 flex-1">
      {/* No width transition: every intermediate width would resize tmux. */}
      <aside
        className={cn(
          "hidden shrink-0 border-r border-sidebar-border bg-sidebar pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] text-sidebar-foreground md:block",
          collapsed
            ? "w-[calc(3.5rem+env(safe-area-inset-left))]"
            : "w-[calc(16rem+env(safe-area-inset-left))]",
        )}
      >
        <SessionSidebar
          sessions={sessions}
          active={active}
          onSelect={select}
          onNew={openPalette}
          onAction={onAction}
          collapsed={collapsed}
          controls={(side) => controls(side, true)}
          footer={
            (!collapsed || hasUsage) && (
              <UsageMeters
                usage={usage}
                collapsed={collapsed}
                onRefresh={refreshUsage}
                refreshing={refreshingUsage}
              />
            )
          }
        />
      </aside>

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent
          side="left"
          showCloseButton={false}
          aria-describedby={undefined}
          // Let the terminal take focus back, not the menu button.
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="gap-0 border-sidebar-border bg-sidebar p-0 pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] text-sidebar-foreground data-[side=left]:w-72 md:hidden"
        >
          <SheetTitle className="sr-only">Sessions</SheetTitle>
          <SessionSidebar
            sessions={sessions}
            active={active}
            onSelect={(name) => {
              select(name);
              setDrawerOpen(false);
            }}
            onNew={openPalette}
            onAction={onAction}
            controls={(side) => controls(side, false)}
            footer={
              <UsageMeters
                usage={usage}
                onRefresh={refreshUsage}
                refreshing={refreshingUsage}
              />
            }
          />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="shrink-0 border-b bg-background pt-[env(safe-area-inset-top)] md:hidden">
          <div className="flex h-11 items-center gap-2 px-1.5">
            <IconButton
              label="Sessions"
              onClick={() => setDrawerOpen(true)}
              className="relative"
            >
              <Menu />
              {otherBusy && (
                <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-bolt" />
              )}
            </IconButton>
            {activeSession && (
              <>
                <StatusDot
                  busy={activeSession.idleSeconds < BUSY_SECONDS}
                  selected
                />
                <span className="min-w-0 truncate font-mono text-sm">
                  {activeSession.name}
                </span>
              </>
            )}
            <div className="ml-auto flex items-center">
              <IconButton label="New session" onClick={openPalette}>
                <Plus />
              </IconButton>
              {keysButton("bottom")}
            </div>
          </div>
        </header>

        <main className="flex min-h-0 flex-1 flex-col bg-terminal">
          {sessions.length === 0 ? (
            <EmptyState onNew={openPalette} />
          ) : (
            opened.map((name) => (
              <TerminalPane
                key={name}
                session={name}
                active={name === active}
                fontSize={fontSize}
                ctrlRef={ctrlRef}
                onCtrlConsumed={() => setCtrlArmed(false)}
                register={register}
              />
            ))
          )}
        </main>

        {showKeys && sessions.length > 0 && (
          <KeyBar
            ctrl={ctrl}
            onToggleCtrl={() => setCtrlArmed(!ctrl)}
            onKey={sendKey}
          />
        )}
      </div>

      <NewSessionPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        sessions={sessions}
        onSwitch={select}
        onCreated={(name, next) => {
          setSessions(next);
          select(name);
        }}
        onCloseFocus={focusTerminal}
      />

      <RenameDialog
        name={target}
        open={dialog === "rename"}
        onOpenChange={(open) => !open && setDialog(null)}
        onRename={rename}
        onCloseFocus={focusTerminal}
      />

      <AlertDialog
        open={dialog === "kill"}
        onOpenChange={(open) => !open && setDialog(null)}
      >
        <AlertDialogContent
          size="sm"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            focusTerminal();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              Kill <span className="font-mono">{target}</span>?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This ends the tmux session and everything running in it, Claude
              included. It can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="pointer-coarse:h-10">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="pointer-coarse:h-10"
              onClick={() => target && kill(target)}
            >
              Kill session
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function EmptyState({ onNew }: { onNew(): void }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <TerminalSquare className="size-10 text-muted-foreground" />
        <p className="font-medium text-foreground">No tmux sessions</p>
        <p className="text-sm text-muted-foreground">
          Start one in a folder under ~/repos, or run{" "}
          <code className="font-mono text-foreground">tmux new -s name</code>{" "}
          anywhere and it shows up here as a tab.
        </p>
        <Button onClick={onNew} className="mt-1 pointer-coarse:h-10">
          <Plus /> New session
          <Kbd className="ml-1 pointer-coarse:hidden">⌘K</Kbd>
        </Button>
      </div>
    </div>
  );
}
