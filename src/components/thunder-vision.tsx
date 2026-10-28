"use client";

import {
  Keyboard,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  TerminalSquare,
  Workflow,
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
import { NewWorkflowDialog } from "@/components/new-workflow-dialog";
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
import { WorkflowList } from "@/components/workflow-list";
import { WorkflowView } from "@/components/workflow-view";
import type { WorkflowSummary } from "@/lib/workflows";
import { notify, subscribe, usePref } from "@/lib/prefs";
import { shellPath, uploadFile } from "@/lib/upload";
import { cn } from "@/lib/utils";
import type { TmuxSession } from "@/server/tmux";

const POLL_MS = 2000;
const MIN_FONT = 9;
const MAX_FONT = 22;

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

const isTouch = () => matchMedia("(pointer: coarse)").matches;

/**
 * At most one reload per RELOAD_GAP_MS, per tab, so a server that keeps
 * restarting (a run of saves, a crash loop) can't keep the page reloading.
 * Until then the page stays up and polls; the reload happens after the gap.
 */
const RELOAD_GAP_MS = 15_000;
function reloadAllowed() {
  try {
    const last = Number(sessionStorage.getItem("tv:reloadedAt")) || 0;
    if (Date.now() - last < RELOAD_GAP_MS) return false;
    sessionStorage.setItem("tv:reloadedAt", String(Date.now()));
  } catch {}
  return true;
}

/** "#wf:<id>" or "#wf:<id>/<run>". Colons can't be in a tmux session name. */
function parseWorkflowHash(hash: string | null) {
  if (!hash?.startsWith("wf:")) return null;
  const [id, run] = hash.slice(3).split("/");
  return { id, run: run || null };
}

export function ThunderVision({
  initialSessions,
  initialWorkflows,
  workflowDocs,
}: {
  initialSessions: TmuxSession[];
  initialWorkflows: WorkflowSummary[];
  /** docs/workflows.md, for Claude to read when writing one. */
  workflowDocs: string;
}) {
  const [sessions, setSessionsState] = useState(initialSessions);
  // Bumped on every update, so a poll that started before a create/kill
  // can't land afterwards and resurrect the old list.
  const sessionsVersion = useRef(0);
  const setSessions = useCallback((next: TmuxSession[]) => {
    sessionsVersion.current++;
    setSessionsState(next);
  }, []);
  const [workflows, setWorkflowsState] = useState(initialWorkflows);
  const workflowsVersion = useRef(0);
  const setWorkflows = useCallback((next: WorkflowSummary[]) => {
    workflowsVersion.current++;
    setWorkflowsState(next);
  }, []);
  const [creating, setCreating] = useState(false);
  // Panes stay mounted after first visit so switching tabs is instant.
  const [visited, setVisited] = useState<string[]>([]);
  const [ctrl, setCtrl] = useState(false);
  const ctrlRef = useRef(false);
  const panes = useRef(new Map<string, PaneHandle>());
  // A file is being dragged over the terminal.
  const [dropping, setDropping] = useState(false);

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
  const wfHash = parseWorkflowHash(hash);
  const activeWorkflow = wfHash
    ? workflows.find((w) => w.id === wfHash.id)
    : undefined;
  // The session shown when no workflow is: the hash's, else the first.
  const current = hash && names.includes(hash) ? hash : (names[0] ?? null);
  const active = activeWorkflow ? null : current;
  const opened = names.filter((n) => n === active || visited.includes(n));

  const select = (name: string) => {
    setVisited((prev) => [
      ...new Set([...prev, name, ...(active ? [active] : [])]),
    ]);
    setHash(name);
  };

  const selectWorkflow = (id: string, run: string | null = null) => {
    // Keep the session's pane mounted for when you come back.
    if (active) setVisited((prev) => [...new Set([...prev, active])]);
    setHash(run ? `wf:${id}/${run}` : `wf:${id}`);
  };

  // Poll tmux. New sessions appear as tabs; vanished ones drop their panes.
  // Also reloads the page after a server restart: a backgrounded tab (iOS
  // especially) misses the HMR update, and would otherwise show stale UI.
  useEffect(() => {
    let stopped = false;
    let boot: string | null = null;
    const refresh = async () => {
      const version = sessionsVersion.current;
      const workflowsAt = workflowsVersion.current;
      try {
        const [res, wfRes] = await Promise.all([
          fetch("/api/sessions", { cache: "no-store" }),
          fetch("/api/workflows", { cache: "no-store" }),
        ]);
        const seen = res.headers.get("X-TV-Boot");
        if (boot && seen && seen !== boot && reloadAllowed()) {
          return location.reload();
        }
        boot ??= seen;
        const next = res.ok ? await res.json() : null;
        if (next && !stopped && version === sessionsVersion.current) {
          setSessions(next);
        }
        const nextWorkflows = wfRes.ok ? await wfRes.json() : null;
        if (
          nextWorkflows &&
          !stopped &&
          workflowsAt === workflowsVersion.current
        ) {
          setWorkflows(nextWorkflows);
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
  }, [setSessions, setWorkflows]);

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

  const newWorkflow = () => {
    setDrawerOpen(false);
    setCreating(true);
  };

  const openedSession = (name: string, next: TmuxSession[]) => {
    setSessions(next);
    select(name);
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

  // Shown in the new order at once; the poll can't undo it (the version
  // bump), and a failure puts it back.
  const reorderSessions = async (order: string[]) => {
    const before = sessions;
    const byName = new Map(sessions.map((s) => [s.name, s]));
    setSessions(order.flatMap((n) => byName.get(n) ?? []));
    try {
      const res = await fetch("/api/sessions/order", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names: order }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setSessions(data.sessions);
    } catch (err) {
      setSessions(before);
      toast.error(err instanceof Error ? err.message : `Couldn't reorder`);
    }
  };

  const reorderWorkflows = async (order: string[]) => {
    const before = workflows;
    const byId = new Map(workflows.map((w) => [w.id, w]));
    setWorkflows(order.flatMap((id) => byId.get(id) ?? []));
    try {
      const res = await fetch("/api/workflows/order", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: order }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setWorkflows(data.workflows);
    } catch (err) {
      setWorkflows(before);
      toast.error(err instanceof Error ? err.message : `Couldn't reorder`);
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

  /**
   * Uploads files to this Mac and types their paths into the session, as
   * dragging a file into a local terminal would. Claude Code attaches an
   * image when it sees its path.
   */
  const attach = async (files: File[]) => {
    const target = active;
    if (!target || !files.length) return;
    const abort = new AbortController();
    const total = files.reduce((n, f) => n + f.size, 0) || 1;
    const sent = files.map(() => 0);
    const what = files.length === 1 ? files[0].name : `${files.length} files`;
    const id = toast.loading(`Uploading ${what}`);
    const show = () =>
      toast.loading(
        `Uploading ${what} ${Math.round((sent.reduce((a, b) => a + b, 0) / total) * 100)}%`,
        { id, action: { label: "Cancel", onClick: () => abort.abort() } },
      );
    show();
    try {
      const paths = await Promise.all(
        files.map((f, i) =>
          uploadFile(
            f,
            (fraction) => {
              sent[i] = fraction * f.size;
              show();
            },
            abort.signal,
          ),
        ),
      );
      toast.dismiss(id);
      const pane = panes.current.get(target);
      pane?.send(`${paths.map(shellPath).join(" ")} `);
      if (!isTouch()) pane?.focus();
    } catch (err) {
      abort.abort();
      if (err instanceof DOMException && err.name === "AbortError") {
        toast.dismiss(id);
      } else {
        toast.error(err instanceof Error ? err.message : "Upload failed", {
          id,
        });
      }
    }
  };

  // Pasting an image (a screenshot, say) into a terminal uploads it, like
  // the paperclip. Text wins when there's both, as when copying from a doc.
  const onPaste = useEffectEvent((e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    const inTerminal = (e.target as Element | null)?.closest?.(".xterm");
    if (!inTerminal || !files.length || e.clipboardData?.getData("text")) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    attach(files);
  });
  useEffect(() => {
    window.addEventListener("paste", onPaste, true);
    return () => window.removeEventListener("paste", onPaste, true);
  }, []);

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
          onReorder={reorderSessions}
          collapsed={collapsed}
          controls={(side) => controls(side, true)}
          workflows={
            <WorkflowList
              workflows={workflows}
              active={activeWorkflow?.id ?? null}
              onSelect={(id) => selectWorkflow(id)}
              onNew={newWorkflow}
              onReorder={reorderWorkflows}
              collapsed={collapsed}
            />
          }
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
            onReorder={reorderSessions}
            controls={(side) => controls(side, false)}
            workflows={
              <WorkflowList
                workflows={workflows}
                active={activeWorkflow?.id ?? null}
                onSelect={(id) => {
                  selectWorkflow(id);
                  setDrawerOpen(false);
                }}
                onNew={newWorkflow}
                onReorder={reorderWorkflows}
              />
            }
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
            {activeWorkflow && (
              <>
                <Workflow className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate text-sm">
                  {activeWorkflow.name}
                </span>
              </>
            )}
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
              {!activeWorkflow && keysButton("bottom")}
            </div>
          </div>
        </header>

        <main
          className="relative flex min-h-0 flex-1 flex-col bg-terminal"
          onDragOver={(e) => {
            if (!active || !e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setDropping(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setDropping(false);
            }
          }}
          onDrop={(e) => {
            if (!dropping) return;
            e.preventDefault();
            setDropping(false);
            attach(Array.from(e.dataTransfer.files));
          }}
        >
          {dropping && (
            <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/60 bg-background/70 text-sm text-foreground">
              Drop to upload and type its path
            </div>
          )}
          {activeWorkflow && (
            <WorkflowView
              key={activeWorkflow.id}
              workflow={activeWorkflow}
              runId={wfHash?.run ?? null}
              fontSize={fontSize}
              docs={workflowDocs}
              onSelectRun={(run) => selectWorkflow(activeWorkflow.id, run)}
              onWorkflows={setWorkflows}
              onOpenSession={openedSession}
              onSwitchSession={select}
            />
          )}
          {sessions.length === 0
            ? !activeWorkflow && <EmptyState onNew={openPalette} />
            : opened.map((name) => (
                <TerminalPane
                  key={name}
                  session={name}
                  active={name === active}
                  fontSize={fontSize}
                  ctrlRef={ctrlRef}
                  onCtrlConsumed={() => setCtrlArmed(false)}
                  register={register}
                  inMode={
                    sessions.find((s) => s.name === name)?.inMode ?? false
                  }
                  onSessions={setSessions}
                />
              ))}
        </main>

        {showKeys && active && (
          <KeyBar
            ctrl={ctrl}
            onToggleCtrl={() => setCtrlArmed(!ctrl)}
            onKey={sendKey}
            onAttach={attach}
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

      <NewWorkflowDialog
        open={creating}
        docs={workflowDocs}
        onOpenChange={setCreating}
        onCreated={(_, next) => {
          setWorkflows(next);
          setCreating(false);
        }}
        onOpenSession={openedSession}
        onSwitchSession={select}
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
