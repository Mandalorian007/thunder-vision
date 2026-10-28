"use client";

import { useEffect, useId, useState } from "react";
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
import { toSessionName } from "@/lib/names";
import { editWithClaude, openSession } from "@/lib/open-session";
import { cn } from "@/lib/utils";
import { slugify, type WorkflowSummary } from "@/lib/workflows";
import type { Dir } from "@/server/repos";
import type { TmuxSession } from "@/server/tmux";

const touch = "pointer-coarse:h-10 pointer-coarse:text-base";

/**
 * Writes a template workflow file for a folder, then opens a session with
 * Claude helping fill it in. There's no YAML editor here on purpose.
 */
export function NewWorkflowDialog({
  open,
  docs,
  onOpenChange,
  onCreated,
  onOpenSession,
  onSwitchSession,
}: {
  open: boolean;
  /** docs/workflows.md, for Claude to read. */
  docs: string;
  onOpenChange(open: boolean): void;
  onCreated(id: string | null, workflows: WorkflowSummary[]): void;
  onOpenSession(name: string, sessions: TmuxSession[]): void;
  onSwitchSession(name: string): void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        onCloseAutoFocus={(e) => e.preventDefault()}
        className="top-[max(1rem,6dvh)] max-h-[calc(100dvh-2rem)] translate-y-0 overflow-y-auto sm:max-w-md"
      >
        {open && (
          <NewWorkflowForm
            docs={docs}
            onCancel={() => onOpenChange(false)}
            onCreated={onCreated}
            onOpenSession={onOpenSession}
            onSwitchSession={onSwitchSession}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function NewWorkflowForm({
  docs,
  onCancel,
  onCreated,
  onOpenSession,
  onSwitchSession,
}: {
  docs: string;
  onCancel(): void;
  onCreated(id: string | null, workflows: WorkflowSummary[]): void;
  onOpenSession(name: string, sessions: TmuxSession[]): void;
  onSwitchSession(name: string): void;
}) {
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirs, setDirs] = useState<Dir[]>([]);
  const listId = useId();

  useEffect(() => {
    fetch("/api/dirs")
      .then((r) => (r.ok ? r.json() : []))
      .then(setDirs, () => {});
  }, []);

  const submit = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir, name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      const { id, file, workflows } = data as {
        id: string | null;
        file: string;
        workflows: WorkflowSummary[];
      };
      onCreated(id, workflows);
      const wf = workflows.find((w) => w.id === id);
      await openSession(
        {
          dir: wf?.dir ?? dir,
          name: toSessionName(`wf-${slugify(name)}`),
          command: editWithClaude(file, docs),
        },
        { opened: onOpenSession, switchTo: onSwitchSession },
      ).catch((err) =>
        toast.error(
          `Wrote ${file}, but couldn't open a session: ${
            err instanceof Error ? err.message : err
          }`,
        ),
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't make the workflow",
      );
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>New workflow</DialogTitle>
        <DialogDescription>
          Writes a starter file and opens Claude in that folder to fill it in.
          In a repo it goes in <code>.thunder/workflows/</code>, to commit with
          the code.
        </DialogDescription>
      </DialogHeader>

      <label className="flex min-w-0 flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">Name</span>
        <Input
          autoFocus
          required
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Fix dependencies"
          className={touch}
        />
      </label>
      <label className="flex min-w-0 flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          Folder
        </span>
        <Input
          required
          list={listId}
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          placeholder="my-app or ~/path"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className={cn("font-mono", touch)}
        />
        <datalist id={listId}>
          {dirs
            .filter((x) => x.rel)
            .map((x) => (
              <option key={x.rel} value={x.rel}>
                {x.path}
              </option>
            ))}
        </datalist>
      </label>

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
          Create and edit
        </Button>
      </DialogFooter>
    </form>
  );
}
