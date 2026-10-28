import { execFile } from "node:child_process";
import { access, mkdir, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { basename, sessionNameForRel, toSessionName } from "@/lib/names";
import { tildify } from "./tmux";

const run = promisify(execFile);
const home = os.homedir();

// turbopackIgnore: these are runtime paths on this machine, not app files to
// bundle; without it the build tries to trace the whole home folder.

/** "~/x" → "/Users/you/x"; .env files don't expand it the way a shell does. */
const untilde = (p: string) =>
  p === "~" || p.startsWith("~/") ? path.join(home, p.slice(1)) : p;

/** The palette lists this folder and two levels below it. */
export const ROOT = path.resolve(
  /*turbopackIgnore: true*/ untilde(
    process.env.TV_ROOT || path.join(home, "repos"),
  ),
);
export const ROOT_NAME = path.basename(ROOT);

export const SKIP = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  "venv",
  "__pycache__",
]);

/** Listed folders: no dot-folders (.git, .cache…). */
export const SEGMENT = /^[\w-][\w.-]*$/;

export type Dir = {
  /** Relative to ROOT; "" is ROOT itself. */
  rel: string;
  /** Display path, e.g. "~/repos/my-app". Matches TmuxSession.path. */
  path: string;
  depth: 0 | 1 | 2;
  branch: string | null;
  modifiedAt: number;
  /** Name a new session here gets. */
  sessionName: string;
};

async function branchOf(dir: string) {
  try {
    const head = (
      await readFile(path.join(dir, ".git", "HEAD"), "utf8")
    ).trim();
    return /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] ?? head.slice(0, 7);
  } catch {
    return null;
  }
}

async function subdirs(dir: string) {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter(
        (e) => e.isDirectory() && SEGMENT.test(e.name) && !SKIP.has(e.name),
      )
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Under ROOT: "a/b" → "a-b". Elsewhere: the folder's own name. */
export function sessionNameFor(abs: string) {
  const rel = path.relative(ROOT, abs);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    return sessionNameForRel(rel, ROOT_NAME);
  }
  return toSessionName(basename(abs) || "root");
}

/** "my-app" and "a/b" are under ROOT; "~/x" and "/x" are taken as-is. */
export function toAbsolute(input: string) {
  return path.resolve(ROOT, untilde(input.trim()));
}

export async function listDirs(): Promise<Dir[]> {
  const top = await subdirs(ROOT);
  const nested = await Promise.all(
    top.map(async (name) =>
      (await subdirs(path.join(ROOT, name))).map((c) => `${name}/${c}`),
    ),
  );
  const rels = ["", ...top, ...nested.flat()];

  const dirs = await Promise.all(
    rels.map(async (rel): Promise<Dir | null> => {
      const abs = path.join(ROOT, rel);
      const depth = rel === "" ? 0 : rel.includes("/") ? 2 : 1;
      try {
        const [info, branch] = await Promise.all([
          stat(abs),
          depth === 2 ? null : branchOf(abs),
        ]);
        return {
          rel,
          path: tildify(abs),
          depth,
          branch,
          modifiedAt: info.mtimeMs,
          sessionName: sessionNameForRel(rel, ROOT_NAME),
        };
      } catch {
        return null;
      }
    }),
  );
  return dirs.filter((d) => d !== null);
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

/** What went wrong, for the user: git's own message beats a stack trace. */
export class SetupError extends Error {}

function gitError(err: unknown) {
  const e = err as { stderr?: string; killed?: boolean; message: string };
  if (e.killed) return new SetupError("git timed out");
  const lines = (e.stderr || e.message).trim().split("\n");
  return new SetupError(lines.findLast((l) => l.trim()) ?? "git failed");
}

/**
 * Gets `abs` ready to start a session in: clones into it, or creates it, then
 * optionally `git init`s it. Throws SetupError with a user-facing message.
 */
export async function prepareDir(
  abs: string,
  opts: { create?: boolean; git?: boolean; clone?: string },
) {
  // Never prompt for credentials: nobody can answer, and it would hang.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (opts.clone) {
    if (await exists(abs)) {
      throw new SetupError(`${tildify(abs)} already exists`);
    }
    await mkdir(path.dirname(abs), { recursive: true });
    try {
      await run("git", ["clone", "--quiet", "--", opts.clone, abs], {
        env,
        timeout: 5 * 60_000,
      });
    } catch (err) {
      throw gitError(err);
    }
  } else if (opts.create) {
    await mkdir(abs, { recursive: true });
  }

  const info = await stat(abs).catch(() => null);
  if (!info) throw new SetupError(`${tildify(abs)} doesn't exist`);
  if (!info.isDirectory()) {
    throw new SetupError(`${tildify(abs)} isn't a folder`);
  }

  if (opts.git && !(await exists(path.join(abs, ".git")))) {
    try {
      await run("git", ["init", "--quiet"], { cwd: abs, env });
    } catch (err) {
      throw gitError(err);
    }
  }
}
