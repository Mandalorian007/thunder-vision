"use client";

import { useState } from "react";
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

export function RenameDialog({
  name,
  open,
  onOpenChange,
  onRename,
  onCloseFocus,
}: {
  name: string | null;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Resolves true when renamed, so the dialog can close. */
  onRename(from: string, to: string): Promise<boolean>;
  onCloseFocus(): void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          onCloseFocus();
        }}
        className="top-[max(1rem,15dvh)] translate-y-0 sm:max-w-sm"
      >
        {/* Keyed so each open starts from the current name. */}
        {name && (
          <RenameForm
            key={name}
            name={name}
            onCancel={() => onOpenChange(false)}
            onRename={onRename}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function RenameForm({
  name,
  onCancel,
  onRename,
}: {
  name: string;
  onCancel(): void;
  onRename(from: string, to: string): Promise<boolean>;
}) {
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const next = toSessionName(value);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!next || busy) return;
        if (next === name) return onCancel();
        setBusy(true);
        if (!(await onRename(name, next))) setBusy(false);
      }}
    >
      <DialogHeader>
        <DialogTitle>Rename session</DialogTitle>
        <DialogDescription>
          Anything running in <span className="font-mono">{name}</span> keeps
          running.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <Input
          autoFocus
          // Select it all so typing replaces the old name.
          onFocus={(e) => e.currentTarget.select()}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="New name"
          className="font-mono pointer-coarse:h-10 pointer-coarse:text-base"
        />
        {next && next !== value.trim() && (
          <span className="text-xs text-muted-foreground">
            tmux will call it <span className="font-mono">{next}</span>
          </span>
        )}
      </div>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          className="pointer-coarse:h-10"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={!next || busy}
          className="pointer-coarse:h-10"
        >
          Rename
        </Button>
      </DialogFooter>
    </form>
  );
}
