"use client";

import {
  ArrowLeft,
  Folder,
  FolderGit2,
  FolderInput,
  FolderPlus,
  GitBranchPlus,
  GitFork,
  LoaderCircle,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import {
  basename,
  GIT_URL,
  repoName,
  sessionNameForRel,
  toSessionName,
} from "@/lib/names";
import { cn } from "@/lib/utils";
import type { Dir } from "@/server/repos";
import type { TmuxSession } from "@/server/tmux";

/** A folder name or path under TV_ROOT that we could create. */
const NEW_REL = /^[\w-][\w.-]*(\/[\w-][\w.-]*)*$/;
const RECENT_KEY = "tv:recentCommands";
const SUGGESTED = ["claude", "claude --resume", "claude --continue"];

function ago(ms: number) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  return `${Math.floor(s / (30 * 86_400))}mo ago`;
}

function readRecent(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((c) => typeof c === "string") : [];
  } catch {
    return [];
  }
}

function rememberCommand(command: string) {
  try {
    const next = [command, ...readRecent().filter((c) => c !== command)];
    localStorage.setItem(RECENT_KEY, JSON.stringify(next.slice(0, 6)));
  } catch {}
}

/** Everything needed to start a session; the options card edits a copy. */
type Plan = {
  /** Where it'll run, for display. */
  title: string;
  /** Sent to the server: relative to TV_ROOT, or "~/…" / "/…". */
  dir: string;
  name: string;
  create?: boolean;
  clone?: string;
  /** Offer `git init` (folder has no repo yet). */
  canGit: boolean;
  git?: boolean;
  command?: string;
};

type Action = {
  key: string;
  icon: typeof Folder;
  label: string;
  hint: string;
  plan: Plan;
};

type Props = {
  open: boolean;
  onOpenChange(open: boolean): void;
  sessions: TmuxSession[];
  /** Switch to an existing session. */
  onSwitch(name: string): void;
  onCreated(name: string, sessions: TmuxSession[]): void;
  /** Where focus goes when the palette closes (the active terminal). */
  onCloseFocus(): void;
};

export function NewSessionPalette({
  open,
  onOpenChange,
  sessions,
  onSwitch,
  onCreated,
  onCloseFocus,
}: Props) {
  const [dirs, setDirs] = useState<Dir[] | null>(null);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState("");
  /** Set while the options card is showing. */
  const [card, setCard] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Fresh listing each time it opens; folders change while you work.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/dirs", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(res.statusText)))
      .then((list: Dir[]) => !cancelled && setDirs(list))
      .catch(() => !cancelled && toast.error("Couldn't list your folders"));
    return () => {
      cancelled = true;
    };
  }, [open]);

  const close = () => {
    onOpenChange(false);
    setQuery("");
    setCard(null);
  };

  const start = async (plan: Plan) => {
    setBusy(plan.clone ? "Cloning…" : "Starting…");
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dir: plan.dir,
          name: plan.name,
          create: plan.create,
          clone: plan.clone,
          git: plan.git,
          command: plan.command,
        }),
      });
      const data = await res.json();
      if (res.status === 409) {
        toast(data.error, {
          action: {
            label: "Switch",
            onClick: () => {
              onSwitch(data.name);
              close();
            },
          },
        });
        return;
      }
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      if (plan.command) rememberCommand(plan.command);
      onCreated(data.name, data.sessions);
      close();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't create session",
      );
    } finally {
      setBusy(null);
    }
  };

  const all = dirs ?? [];
  const rootPath = all.find((d) => d.rel === "")?.path ?? "~/repos";
  const rootName = basename(rootPath);

  // A session "lives" in a folder if its active pane is there.
  const running = new Map(sessions.map((s) => [s.path, s.name]));
  const searching = query.trim() !== "";
  const live = all.filter((d) => running.has(d.path));
  // Subfolders are noise until you search for them.
  const rest = all
    .filter((d) => !running.has(d.path) && (searching || d.depth < 2))
    .sort((a, b) => b.modifiedAt - a.modifiedAt);

  const dirPlan = (d: Dir): Plan => ({
    title: d.path,
    dir: d.rel,
    name: d.sessionName,
    // Never offer to git init TV_ROOT itself.
    canGit: d.depth === 1 && !d.branch,
  });

  // Typed input that isn't an existing folder becomes an action.
  const raw = query.trim();
  const q = raw.startsWith(`${rootPath}/`)
    ? raw.slice(rootPath.length + 1)
    : raw;
  const actions: Action[] = [];
  if (GIT_URL.test(raw)) {
    const name = repoName(raw);
    actions.push({
      key: "__clone__",
      icon: GitFork,
      label: `Clone into ${rootPath}/${name}`,
      hint: raw,
      plan: {
        title: `${rootPath}/${name}`,
        dir: name,
        name: toSessionName(name),
        clone: raw,
        canGit: false,
      },
    });
  } else if (/^[~/]/.test(q)) {
    actions.push({
      key: "__path__",
      icon: FolderInput,
      label: `Start in ${q}`,
      hint: "creates the folder if it's missing",
      plan: {
        title: q,
        dir: q,
        name: toSessionName(basename(q) || "root"),
        create: true,
        canGit: true,
      },
    });
  } else if (
    NEW_REL.test(q) &&
    !all.some((d) => d.rel.toLowerCase() === q.toLowerCase())
  ) {
    const plan: Plan = {
      title: `${rootPath}/${q}`,
      dir: q,
      name: sessionNameForRel(q, rootName),
      create: true,
      canGit: true,
    };
    actions.push(
      {
        key: "__create__",
        icon: FolderPlus,
        label: `Create ${plan.title}`,
        hint: "mkdir, then a new tmux session there",
        plan,
      },
      {
        key: "__create_git__",
        icon: GitBranchPlus,
        label: `Create ${plan.title} + git init`,
        hint: "a fresh repo to start in",
        plan: { ...plan, git: true },
      },
    );
  }

  // For Tab: which plan the highlighted row stands for.
  const plans = new Map<string, Plan>([
    ...rest.map((d) => [itemValue(d), dirPlan(d)] as const),
    ...actions.map((a) => [a.key, a.plan] as const),
  ]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
    >
      <DialogContent
        showCloseButton={false}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          onCloseFocus();
        }}
        onEscapeKeyDown={(e) => {
          // Esc on the card steps back to the list instead of closing.
          if (card) {
            e.preventDefault();
            setCard(null);
          }
        }}
        // Pinned near the top so a phone keyboard never covers the results.
        className="top-[max(1rem,10dvh)] translate-y-0 gap-0 overflow-hidden rounded-xl! p-0 sm:max-w-lg"
      >
        <DialogTitle className="sr-only">New session</DialogTitle>
        <DialogDescription className="sr-only">
          Pick a folder to start a tmux session in, or type a new folder, a
          path, or a git URL.
        </DialogDescription>

        {card ? (
          <OptionsCard
            plan={card}
            busy={busy}
            onBack={() => setCard(null)}
            onStart={start}
          />
        ) : (
          <Command
            loop
            value={highlighted}
            onValueChange={setHighlighted}
            onKeyDown={(e) => {
              const plan = plans.get(highlighted);
              if (e.key === "Tab" && !e.shiftKey && plan && !busy) {
                e.preventDefault();
                setCard(plan);
              }
            }}
          >
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="Search folders, or a new name, path or git URL…"
              // 16px stops iOS zooming in on focus.
              className="pointer-coarse:text-base"
            />
            <CommandList className="max-h-[min(24rem,50dvh)]">
              <CommandEmpty>
                {dirs === null ? (
                  <span className="inline-flex items-center gap-2">
                    <LoaderCircle className="size-4 animate-spin" /> Reading
                    folders…
                  </span>
                ) : (
                  "No folders match."
                )}
              </CommandEmpty>

              {actions.length > 0 && (
                <CommandGroup heading="New" forceMount>
                  {actions.map((a) => (
                    <CommandItem
                      key={a.key}
                      value={a.key}
                      forceMount
                      disabled={!!busy}
                      onSelect={() => start(a.plan)}
                      className="group gap-3 py-2 pointer-coarse:py-3"
                    >
                      <a.icon className="text-primary" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-[13px]">
                          {a.label}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {a.hint}
                        </div>
                      </div>
                      <OptionsButton onClick={() => setCard(a.plan)} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}

              {live.length > 0 && (
                <CommandGroup heading="Running">
                  {live.map((d) => (
                    <DirItem
                      key={d.rel}
                      dir={d}
                      disabled={!!busy}
                      note={
                        <span className="text-bolt">
                          ● {running.get(d.path)}
                        </span>
                      }
                      onSelect={() => {
                        onSwitch(running.get(d.path)!);
                        close();
                      }}
                    />
                  ))}
                </CommandGroup>
              )}

              {rest.length > 0 && (
                <CommandGroup heading={searching ? "Folders" : "Recent"}>
                  {rest.map((d) => (
                    <DirItem
                      key={d.rel}
                      dir={d}
                      disabled={!!busy}
                      note={
                        <>
                          {d.branch && (
                            <span className="max-w-24 truncate font-mono">
                              {d.branch}
                            </span>
                          )}
                          <span className="tabular-nums">
                            {ago(d.modifiedAt)}
                          </span>
                        </>
                      }
                      onSelect={() => start(dirPlan(d))}
                      onOptions={() => setCard(dirPlan(d))}
                    />
                  ))}
                </CommandGroup>
              )}
            </CommandList>

            <div
              className={cn(
                "flex items-center gap-3 border-t px-3 py-2 text-xs text-muted-foreground",
                !busy && "pointer-coarse:hidden",
              )}
            >
              {busy ? (
                <span className="inline-flex items-center gap-1.5">
                  <LoaderCircle className="size-3.5 animate-spin" /> {busy}
                </span>
              ) : (
                <>
                  <span>
                    <Kbd>↵</Kbd> open
                  </span>
                  <span>
                    <Kbd>⇥</Kbd> options
                  </span>
                  <span>
                    <Kbd>esc</Kbd> close
                  </span>
                </>
              )}
            </div>
          </Command>
        )}
      </DialogContent>
    </Dialog>
  );
}

const itemValue = (d: Dir) => d.rel || d.path;

/** Opens the options card for a row; always visible on touch, where Tab isn't. */
function OptionsButton({ onClick }: { onClick(): void }) {
  return (
    <button
      type="button"
      aria-label="Options"
      tabIndex={-1}
      // cmdk selects on click; this button must not also start the session.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="-my-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 group-data-[selected=true]:opacity-100 hover:bg-background hover:text-foreground pointer-coarse:size-9 pointer-coarse:opacity-100 [&_svg]:size-4"
    >
      <SlidersHorizontal />
    </button>
  );
}

function DirItem({
  dir,
  note,
  disabled,
  onSelect,
  onOptions,
}: {
  dir: Dir;
  note: React.ReactNode;
  disabled: boolean;
  onSelect(): void;
  onOptions?(): void;
}) {
  const Icon = dir.branch ? FolderGit2 : Folder;
  return (
    <CommandItem
      value={itemValue(dir)}
      keywords={[dir.path, dir.sessionName]}
      disabled={disabled}
      onSelect={onSelect}
      className="group gap-3 py-2 pointer-coarse:py-3"
    >
      <Icon className="text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
        {dir.rel ? (
          dir.rel.replace("/", " / ")
        ) : (
          <>
            {dir.path}{" "}
            <span className="font-sans text-xs text-muted-foreground">
              (shell here)
            </span>
          </>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
        {note}
      </span>
      {onOptions && <OptionsButton onClick={onOptions} />}
    </CommandItem>
  );
}

function OptionsCard({
  plan,
  busy,
  onBack,
  onStart,
}: {
  plan: Plan;
  busy: string | null;
  onBack(): void;
  onStart(plan: Plan): void;
}) {
  const [name, setName] = useState(plan.name);
  const [command, setCommand] = useState(plan.command ?? "");
  const [git, setGit] = useState(plan.git ?? false);
  const [recent] = useState(readRecent);
  const chips = [...new Set([...recent, ...SUGGESTED])].slice(0, 6);
  const finalName = toSessionName(name);

  const submit = () =>
    onStart({
      ...plan,
      name: finalName || plan.name,
      command: command.trim() || undefined,
      git: plan.canGit && git,
    });

  return (
    <form
      className="flex flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) submit();
      }}
    >
      <div className="flex items-center gap-2 border-b px-2 py-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Back"
          onClick={onBack}
          className="size-8 pointer-coarse:size-10"
        >
          <ArrowLeft />
        </Button>
        <div className="min-w-0">
          <div className="text-sm font-medium">
            {plan.clone ? "Clone and start" : "New session"}
          </div>
          <div className="truncate font-mono text-xs text-muted-foreground">
            {plan.title}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4 p-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Session name
          </span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={plan.name}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="font-mono pointer-coarse:h-10 pointer-coarse:text-base"
          />
          {finalName && finalName !== name.trim() && (
            <span className="text-xs text-muted-foreground">
              tmux will call it <span className="font-mono">{finalName}</span>
            </span>
          )}
        </label>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="tv-start-command"
            className="text-xs font-medium text-muted-foreground"
          >
            Start command{" "}
            <span className="font-normal">
              (optional, typed into the shell)
            </span>
          </label>
          <Input
            id="tv-start-command"
            autoFocus
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="just a shell"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="font-mono pointer-coarse:h-10 pointer-coarse:text-base"
          />
          <div className="flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCommand(command === c ? "" : c)}
                aria-pressed={command === c}
                className="rounded-md border px-2 py-0.5 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground aria-pressed:border-primary aria-pressed:text-primary pointer-coarse:px-2.5 pointer-coarse:py-1.5"
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        {plan.canGit && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={git}
              onChange={(e) => setGit(e.target.checked)}
              className="size-4 accent-primary pointer-coarse:size-5"
            />
            <span>
              <span className="font-mono">git init</span>{" "}
              <span className="text-muted-foreground">
                {plan.create ? "the new folder" : "this folder"}
              </span>
            </span>
          </label>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
        {busy && (
          <span className="mr-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" /> {busy}
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          onClick={onBack}
          className="pointer-coarse:h-10"
        >
          Back
        </Button>
        <Button type="submit" disabled={!!busy} className="pointer-coarse:h-10">
          {plan.clone ? "Clone & start" : "Start session"}
          <Kbd className="ml-1 pointer-coarse:hidden">↵</Kbd>
        </Button>
      </div>
    </form>
  );
}
