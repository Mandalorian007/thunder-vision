import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * whisper-server processes, one per model, kept warm while you talk.
 *
 * whisper pads every clip to a 30s window, so a one-shot whisper-cli costs
 * about the same whatever the length: ~1.2s with large-v3-turbo, most of it
 * that window plus loading the model. A loaded base.en does the same window
 * in ~90ms, which is what makes a live draft every half second possible.
 * Loopback only, on a free port. They hold ~1 GB between them (the weights),
 * so they run only while you talk: started as the mic opens (loading takes
 * ~0.25s, hidden behind the permission check and your first words) and
 * stopped IDLE_MS after the last phrase.
 */

const IDLE_MS = 60_000;
const BOOT_MS = 30_000;
const TIMEOUT_MS = 60_000;

type Proc = {
  port: number;
  proc: ChildProcess;
  ready: Promise<void>;
  idle?: ReturnType<typeof setTimeout>;
};

/** whisper-server isn't installed (or won't start): use the fallback. */
export class NoServer extends Error {}

// On globalThis: dev reloads re-run this module, and must find the same
// processes rather than start more.
const g = globalThis as unknown as {
  __tvWhisper?: Map<string, Proc>;
};
const procs: Map<string, Proc> = g.__tvWhisper ?? fresh();

function fresh() {
  const all = (g.__tvWhisper = new Map<string, Proc>());
  process.once("exit", () => all.forEach((p) => p.proc.kill()));
  return all;
}

const pidFile = (model: string) =>
  path.join(os.tmpdir(), `thunder-vision-whisper-${path.basename(model)}.pid`);

/** One left behind by a restart that didn't get to say goodbye. */
function killStale(model: string) {
  try {
    const pid = Number(readFileSync(pidFile(model), "utf8"));
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    });
    if (cmd.includes("whisper-server")) process.kill(pid);
  } catch {
    // No file, or nothing running under it.
  }
}

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

async function boot(bin: string, model: string, lang: string): Promise<Proc> {
  killStale(model);
  const port = await freePort();
  const proc = spawn(
    bin,
    [
      ...["-m", model, "--host", "127.0.0.1", "--port", String(port)],
      ...["-l", lang, "-nt", "-sns"],
    ],
    { stdio: "ignore" },
  );
  const p: Proc = { port, proc, ready: Promise.resolve() };
  const gone = new Promise<never>((_, reject) => {
    proc.once("error", (err) => reject(new NoServer(err.message)));
    proc.once("exit", (code) => reject(new NoServer(`exited (${code})`)));
  });
  gone.catch(() => {}); // Only matters while booting.
  proc.once("exit", () => {
    if (procs.get(model) === p) procs.delete(model);
    clearTimeout(p.idle);
  });
  if (proc.pid) writeFileSync(pidFile(model), String(proc.pid));
  // It listens once the model is loaded: any answer means ready.
  const up = (async () => {
    const until = Date.now() + BOOT_MS;
    while (Date.now() < until) {
      try {
        await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(1000),
        });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    proc.kill();
    throw new NoServer("didn't start in time");
  })();
  p.ready = Promise.race([up, gone]);
  p.ready.catch(() => {});
  return p;
}

function touch(model: string, p: Proc) {
  clearTimeout(p.idle);
  p.idle = setTimeout(() => {
    procs.delete(model);
    p.proc.kill();
    rmSync(pidFile(model), { force: true });
  }, IDLE_MS);
  p.idle.unref();
}

// Booting is async; two requests at once must share one process.
const booting = new Map<string, Promise<Proc>>();

async function get(bin: string, model: string, lang: string) {
  let p = procs.get(model);
  if (!p) {
    let b = booting.get(model);
    if (!b) {
      b = boot(bin, model, lang).finally(() => booting.delete(model));
      booting.set(model, b);
    }
    p = await b;
    procs.set(model, p);
  }
  touch(model, p);
  try {
    await p.ready;
  } catch (err) {
    if (procs.get(model) === p) procs.delete(model);
    throw err;
  }
  return p;
}

/** Start it now so the first phrase doesn't wait for the model to load. */
export function warm(bin: string, model: string, lang: string) {
  get(bin, model, lang).catch(() => {});
}

/** 16 kHz mono WAV → text, on a warm server for `model`. */
export async function infer(
  bin: string,
  model: string,
  lang: string,
  wav: Uint8Array,
) {
  const p = await get(bin, model, lang);
  const form = new FormData();
  form.append(
    "file",
    new Blob([wav as Uint8Array<ArrayBuffer>], { type: "audio/wav" }),
    "clip.wav",
  );
  form.append("response_format", "json");
  const res = await fetch(`http://127.0.0.1:${p.port}/inference`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => ({}))) as {
    text?: string;
    error?: string;
  };
  if (!res.ok || json.error) {
    throw new Error(json.error ?? `whisper-server ${res.status}`);
  }
  return json.text ?? "";
}
