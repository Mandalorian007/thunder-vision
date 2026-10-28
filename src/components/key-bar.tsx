"use client";

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CornerDownLeft,
  Paperclip,
} from "lucide-react";
import { useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Keys an on-screen keyboard can't send, tuned for driving Claude Code. */
const KEYS: { label: ReactNode; seq: string; title: string }[] = [
  { label: "esc", seq: "\x1b", title: "Escape" },
  { label: "tab", seq: "\t", title: "Tab" },
  { label: "⇧tab", seq: "\x1b[Z", title: "Shift+Tab (cycle Claude mode)" },
  { label: "^C", seq: "\x03", title: "Ctrl+C" },
  { label: <ArrowLeft />, seq: "\x1b[D", title: "Left" },
  { label: <ArrowUp />, seq: "\x1b[A", title: "Up" },
  { label: <ArrowDown />, seq: "\x1b[B", title: "Down" },
  { label: <ArrowRight />, seq: "\x1b[C", title: "Right" },
  { label: <CornerDownLeft />, seq: "\r", title: "Enter" },
];

type Props = {
  ctrl: boolean;
  onToggleCtrl(): void;
  onKey(seq: string): void;
  /** Files picked with the paperclip, to upload and type the paths of. */
  onAttach(files: File[]): void;
};

const keyClass =
  "flex h-9 min-w-11 shrink-0 items-center justify-center rounded-md border bg-card px-2.5 font-mono text-xs text-card-foreground shadow-xs active:bg-accent [&_svg]:size-4";

export function KeyBar({ ctrl, onToggleCtrl, onKey, onAttach }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  // preventDefault on pointerdown keeps focus in the terminal, so the
  // on-screen keyboard stays up while tapping these.
  return (
    <div className="flex gap-1.5 overflow-x-auto border-t bg-background/95 px-2 py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] [scrollbar-width:none]">
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) onAttach(files);
        }}
      />
      <button
        type="button"
        title="Attach a file (uploads it and types its path)"
        aria-label="Attach a file"
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => fileRef.current?.click()}
        className={keyClass}
      >
        <Paperclip />
      </button>
      <span
        aria-hidden
        className="mx-0.5 w-px shrink-0 self-stretch bg-border"
      />
      <button
        type="button"
        title="Ctrl (applies to the next key)"
        aria-pressed={ctrl}
        onPointerDown={(e) => e.preventDefault()}
        onClick={onToggleCtrl}
        className={cn(
          keyClass,
          ctrl && "border-primary bg-primary text-primary-foreground",
        )}
      >
        ctrl
      </button>
      {KEYS.map((k) => (
        <button
          key={k.title}
          type="button"
          title={k.title}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => onKey(k.seq)}
          className={keyClass}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}
