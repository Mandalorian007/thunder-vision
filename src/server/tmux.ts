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
  /** The active pane is in copy mode: scrolled back, not showing live output. */
  inMode: boolean;
  /** Its place in the sidebar, once dragged; null sorts after, by age. */
  order: number | null;
};

/**
 * The sidebar order, kept on the session itself as a user option: it follows
 * renames, goes when the session does, and setting it touches nothing that
 * runs in the session.
 */
const ORDER_OPTION = "@tv_order";

const FIELDS = [
  "session_name",
  "session_group",
  "session_windows",
  "session_attached",
  "window_activity", // output in the current window; session_activity only tracks input
  "session_created",
  "pane_current_path",
  "pane_current_command",
  "pane_in_mode",
  ORDER_OPTION,
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
      const [
        name,
        group,
        windows,
        attached,
        activity,
        created,
        path,
        command,
        inMode,
        order,
      ] = fields;
      return {
        name,
        group: group || null,
        windows: Number(windows),
        attached: Number(attached),
        idleSeconds: Math.max(0, now - Number(activity)),
        createdAt: Number(created),
        path: tildify(path),
        command,
        inMode: inMode === "1",
        order: /^\d+$/.test(order) ? Number(order) : null,
      };
    })
    .sort(
      (a, b) =>
        (a.order ?? Infinity) - (b.order ?? Infinity) ||
        a.createdAt - b.createdAt,
    );
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

/**
 * Numbers the sessions 0…n-1 in this order. Only sets a user option, so
 * whatever runs in them never notices. A session that vanished meanwhile is
 * skipped.
 */
export async function setSessionOrder(names: string[]) {
  const env = cleanEnv();
  await Promise.all(
    names.map((name, i) =>
      // `=name:`, like send-keys: set-option resolves -t as a pane.
      run(
        TMUX_BIN,
        ["set-option", "-t", `=${name}:`, ORDER_OPTION, String(i)],
        { env },
      ).catch((err) => {
        const stderr = (err as { stderr?: string }).stderr ?? "";
        if (!/can't find|no such session/i.test(stderr)) throw err;
      }),
    ),
  );
}

/** Ends the session and everything running in it, for every client. */
export async function killSession(name: string) {
  await run(TMUX_BIN, ["kill-session", "-t", `=${name}`], { env: cleanEnv() });
}

/** Leaves copy mode in the active pane, back to live output. */
export async function exitCopyMode(name: string) {
  await run(TMUX_BIN, ["send-keys", "-X", "-t", `=${name}:`, "cancel"], {
    env: cleanEnv(),
  }).catch(() => {}); // "not in a mode": already live
}
