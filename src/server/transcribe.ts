import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { infer, NoServer, warm } from "./whisper";

const run = promisify(execFile);
const home = os.homedir();

/** A clip is one phrase (the page cuts at pauses); this is generous. */
export const MAX_CLIP_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

/** launchd's PATH may not have Homebrew on it. */
function bin(env: string | undefined, name: string) {
  if (env) return env;
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin"]) {
    const p = path.join(/*turbopackIgnore: true*/ dir, name);
    if (existsSync(p)) return p;
  }
  return name;
}

const expand = (p: string) => p.replace(/^~(?=\/|$)/, home);

function pick(env: string | undefined, names: string[]) {
  if (env) {
    const p = path.resolve(/*turbopackIgnore: true*/ expand(env));
    return existsSync(p) ? p : null;
  }
  const dir = path.join(/*turbopackIgnore: true*/ home, ".whisper");
  for (const name of names) {
    const p = path.join(/*turbopackIgnore: true*/ dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * The model each phrase is finally typed from: TV_WHISPER_MODEL, else the
 * best found in ~/.whisper. large-v3-turbo is far better with code words.
 */
const model = () =>
  pick(process.env.TV_WHISPER_MODEL, [
    "ggml-large-v3-turbo-q5_0.bin",
    "ggml-large-v3-turbo-q8_0.bin",
    "ggml-large-v3-turbo.bin",
    "ggml-small.en.bin",
    "ggml-base.en.bin",
  ]);

/**
 * The model for the live draft while you talk: fast over accurate, since the
 * final pass replaces it. Without one, drafts use the final model (slower).
 */
const draftModel = () =>
  pick(process.env.TV_WHISPER_DRAFT_MODEL, [
    "ggml-base.en.bin",
    "ggml-base.bin",
    "ggml-tiny.en.bin",
    "ggml-small.en.bin",
  ]) ?? model();

const lang = () => process.env.TV_WHISPER_LANG || "en";
const whisperServer = () =>
  bin(process.env.WHISPER_SERVER_BIN, "whisper-server");

/** Safari records mp4, Chrome webm; ffmpeg needs the right extension hint. */
function extFor(type: string) {
  if (/mp4|m4a|aac/.test(type)) return ".mp4";
  if (/ogg/.test(type)) return ".ogg";
  if (/wav/.test(type)) return ".wav";
  return ".webm";
}

/**
 * whisper's notes about the audio rather than words in it: [BLANK_AUDIO],
 * (music), *laughs*. Lines are joined: a newline would send the prompt.
 */
export function cleanTranscript(text: string) {
  return text
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, " ")
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The fallback runs one at a time: whisper runs share the GPU, and a queue
// keeps phrases from one recording finishing roughly in order anyway.
let queue: Promise<unknown> = Promise.resolve();

export class TranscribeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Already what whisper wants: 16-bit mono 16 kHz WAV (what the page sends). */
function isWav16k(b: Uint8Array) {
  if (b.length < 44) return false;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (o: number) => String.fromCharCode(...b.subarray(o, o + 4));
  return (
    tag(0) === "RIFF" &&
    tag(8) === "WAVE" &&
    v.getUint16(20, true) === 1 &&
    v.getUint16(22, true) === 1 &&
    v.getUint32(24, true) === 16000 &&
    v.getUint16(34, true) === 16
  );
}

/** Start the servers as the mic opens, so the first phrase doesn't wait. */
export function warmUp() {
  const d = draftModel();
  const m = model();
  if (d) warm(whisperServer(), d, lang());
  if (m && m !== d) warm(whisperServer(), m, lang());
}

/**
 * Speech in a recorded clip (wav, webm, mp4 or ogg) → text. A draft is the
 * quick look while you're still talking; it never falls back to the slow
 * path, since a late draft is no use.
 */
export async function transcribe(
  bytes: Uint8Array,
  type: string,
  { draft = false } = {},
): Promise<string> {
  const m = draft ? draftModel() : model();
  if (!m) {
    throw new TranscribeError(
      "No whisper model: put one in ~/.whisper (see docs/configuration.md)",
      503,
    );
  }
  if (isWav16k(bytes)) {
    try {
      return cleanTranscript(await infer(whisperServer(), m, lang(), bytes));
    } catch (err) {
      if (draft) {
        throw new TranscribeError(
          "Drafts need whisper-server",
          err instanceof NoServer ? 503 : 500,
        );
      }
      if (!(err instanceof NoServer)) {
        console.error("[thunder-vision] whisper-server failed:", err);
      }
    }
  } else if (draft) {
    throw new TranscribeError("Drafts must be 16 kHz WAV", 415);
  }
  // No server: one whisper-cli run at a time.
  const job = queue.then(() => transcribeNow(bytes, type, m));
  queue = job.catch(() => {});
  return job;
}

async function transcribeNow(bytes: Uint8Array, type: string, m: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tv-voice-"));
  try {
    const input = path.join(dir, `clip${extFor(type)}`);
    const wav = path.join(dir, "clip.wav");
    writeFileSync(input, bytes);
    try {
      await run(
        bin(process.env.FFMPEG_BIN, "ffmpeg"),
        [
          ...["-nostdin", "-loglevel", "error", "-i", input],
          ...["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav],
        ],
        { timeout: TIMEOUT_MS },
      );
    } catch (err) {
      throw toolError(err, "ffmpeg");
    }
    let stdout: string;
    try {
      ({ stdout } = await run(
        bin(process.env.WHISPER_BIN, "whisper-cli"),
        ["-m", m, "-f", wav, "-l", lang(), "-nt", "-np", "-sns"],
        { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      ));
    } catch (err) {
      throw toolError(err, "whisper-cli");
    }
    return cleanTranscript(stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function toolError(err: unknown, tool: string) {
  const e = err as NodeJS.ErrnoException & { stderr?: string };
  if (e.code === "ENOENT") {
    return new TranscribeError(
      `${tool} not found: brew install ${tool === "ffmpeg" ? "ffmpeg" : "whisper-cpp"}`,
      503,
    );
  }
  const detail = e.stderr?.trim().split("\n").pop() || e.message;
  console.error(`[thunder-vision] ${tool} failed:`, detail);
  return new TranscribeError(`Couldn't transcribe (${tool} failed)`, 500);
}
