import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);
const home = os.homedir();

export const TMUX_BIN = process.env.TMUX_BIN || "tmux";

export type TmuxSession = {
  name: string;
  group: string | null;
  windows: number;
  /** Clients attached right now, including Thunder Vision tabs. */
  attached: number;
  /** Seconds since the current window last printed anything. */
  idleSeconds: number;
  createdAt: number;
  path: string;
  command: string;
};

const FIELDS = [
  "session_name",
  "session_group",
  "session_windows",
  "session_attached",
  "window_activity", // output in the current window; session_activity only tracks input
  "session_created",
  "pane_current_path",
  "pane_current_command",
] as const;

// Unit separator: never appears in session names or paths in practice.
const SEP = "\x1f";
const FORMAT = FIELDS.map((f) => `#{${f}}`).join(SEP);

/** tmux exits non-zero with these messages when no server is running yet. */
const NO_SERVER = /no server running|error connecting to/i;

export function cleanEnv(): NodeJS.ProcessEnv {
  // If Thunder Vision itself runs inside tmux, these make `tmux attach`
  // refuse to start ("sessions should be nested with care").
  // Without a UTF-8 locale (e.g. under launchd) tmux escapes control
  // characters in -F output and mangles unicode on attach.
  const env: NodeJS.ProcessEnv = { LANG: "en_US.UTF-8", ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

export function tildify(p: string) {
  return p === home || p.startsWith(`${home}/`)
    ? `~${p.slice(home.length)}`
    : p;
}

export async function listSessions(): Promise<TmuxSession[]> {
  let stdout: string;
  try {
    ({ stdout } = await run(TMUX_BIN, ["list-sessions", "-F", FORMAT], {
      env: cleanEnv(),
    }));
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    if (NO_SERVER.test(stderr)) return [];
    throw err;
  }

  const now = Math.floor(Date.now() / 1000);
  return stdout
    .split("\n")
    .map((line) => line.split(SEP))
    .filter((fields) => fields.length === FIELDS.length)
    .map((fields) => {
      const [name, group, windows, attached, activity, created, path, command] =
        fields;
      return {
        name,
        group: group || null,
        windows: Number(windows),
        attached: Number(attached),
        idleSeconds: Math.max(0, now - Number(activity)),
        createdAt: Number(created),
        path: tildify(path),
        command,
      };
    })
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function hasSession(name: string): Promise<boolean> {
  return (await listSessions()).some((s) => s.name === name);
}

/**
 * Detached session in `cwd`. A start command is typed into the shell rather
 * than replacing it, so when it exits you're left at a prompt, not a dead tab.
 * Rejects with "duplicate session" stderr on a clash.
 */
export async function newSession(name: string, cwd: string, command?: string) {
  const env = cleanEnv();
  await run(TMUX_BIN, ["new-session", "-d", "-s", name, "-c", cwd], { env });
  if (command) {
    const pane = `=${name}:`;
    await run(TMUX_BIN, ["send-keys", "-t", pane, "-l", "--", command], {
      env,
    });
    await run(TMUX_BIN, ["send-keys", "-t", pane, "Enter"], { env });
  }
}

export async function renameSession(from: string, to: string) {
  await run(TMUX_BIN, ["rename-session", "-t", `=${from}`, "--", to], {
    env: cleanEnv(),
  });
}

/** Ends the session and everything running in it, for every client. */
export async function killSession(name: string) {
  await run(TMUX_BIN, ["kill-session", "-t", `=${name}`], { env: cleanEnv() });
}
