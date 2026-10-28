import { toast } from "sonner";
import type { TmuxSession } from "@/server/tmux";

/** Single-quoted for the shell, whatever is in it. */
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * A new tmux session in `dir` running `command`. If one by that name is
 * already open, offers to switch to it instead. Throws on other errors.
 */
export async function openSession(
  req: { dir: string; name: string; command: string },
  on: {
    opened(name: string, sessions: TmuxSession[]): void;
    switchTo(name: string): void;
  },
) {
  const res = await fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  const data = await res.json();
  if (res.status === 409) {
    toast(data.error, {
      action: { label: "Switch", onClick: () => on.switchTo(data.name) },
    });
    return;
  }
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  on.opened(data.name, data.sessions);
}

/** Claude, asked to help write the workflow in `file`. */
export const editWithClaude = (file: string, docs: string) =>
  `claude ${shellQuote(
    `Help me write the Thunder Vision workflow in ${file}. ` +
      `The format is documented in ${docs}; read that first, ` +
      `then ask me what the workflow should do.`,
  )}`;
