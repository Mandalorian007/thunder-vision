/**
 * Talking into a terminal: the decisions, kept pure so they read (and can be
 * tested) without a microphone. The recorder lives in voice-button.tsx.
 *
 * Learned in lemnos: one button that both holds and taps, and transcribers
 * answer silence with "[BLANK_AUDIO]" or "Thank you.". The page records raw
 * samples rather than MediaRecorder's webm/mp4: any stretch of them is a
 * valid clip (the phrase so far, for a draft), nothing is lost between
 * phrases, and the server needn't run ffmpeg.
 */

/* ---------------------------- The button ------------------------------ */

/**
 * Shorter than this and the press was a tap, which latches: the mic stays on
 * until the next press. Longer, and letting go ends it. A tap that recorded
 * for 90ms and stopped reads as the mic switching itself off.
 */
export const TAP_MS = 400;

export type Gesture = { on: boolean; latched: boolean; since: number };
export const idle: Gesture = { on: false, latched: false, since: 0 };

/** `start` opens the mic, `stop` finishes (sending what's left). */
export function press(
  g: Gesture,
  touch: "down" | "up",
  at: number,
): { g: Gesture; act: "start" | "stop" | null } {
  if (touch === "down") {
    // A press while on ends it; the up that follows finds nothing on.
    if (g.on) return { g: idle, act: "stop" };
    return { g: { on: true, latched: false, since: at }, act: "start" };
  }
  if (!g.on || g.latched) return { g, act: null };
  if (at - g.since < TAP_MS) return { g: { ...g, latched: true }, act: null };
  return { g: idle, act: "stop" };
}

/* ------------------------- Cutting at pauses -------------------------- */

/**
 * The mic stays open while you talk, but each phrase goes off to be
 * transcribed as soon as you pause, and its text is typed while you carry
 * on. A long ramble arrives a phrase at a time, and one bad clip costs a
 * phrase rather than the lot.
 */

/** RMS above this is voice (a quiet room ≈ 0.002, a fan ≈ 0.006). */
export const THRESHOLD = 0.01;
/** Voice in a clip before it's worth transcribing: not a cough or a tap. */
export const MIN_SPEECH_MS = 300;
/** A pause this long after speech ends a phrase. A comma is about 200ms. */
export const PAUSE_MS = 700;
/** Past this, any short breath will do… */
export const SOFT_MAX_MS = 12_000;
const SHORT_PAUSE_MS = 250;
/** …and here it's cut regardless. */
export const HARD_MAX_MS = 25_000;

export type Clip = { heldMs: number; speechMs: number; quietMs: number };
export const fresh: Clip = { heldMs: 0, speechMs: 0, quietMs: 0 };

/**
 * One level reading in. `cut` sends the clip and starts the next; `drop`
 * starts the next without sending (a clip that was all silence).
 */
export function listen(
  c: Clip,
  level: number,
  dtMs: number,
): { c: Clip; act: "cut" | "drop" | null } {
  const loud = level >= THRESHOLD;
  const next: Clip = {
    heldMs: c.heldMs + dtMs,
    speechMs: c.speechMs + (loud ? dtMs : 0),
    quietMs: loud ? 0 : c.quietMs + dtMs,
  };
  const spoke = next.speechMs >= MIN_SPEECH_MS;
  const pause = next.heldMs >= SOFT_MAX_MS ? SHORT_PAUSE_MS : PAUSE_MS;
  if (spoke && next.quietMs >= pause) return { c: fresh, act: "cut" };
  if (next.heldMs >= HARD_MAX_MS) {
    return { c: fresh, act: spoke ? "cut" : "drop" };
  }
  return { c: next, act: null };
}

/**
 * The last clip, when the button lets go. Sent if it had any voice in it;
 * and if nothing was sent all session (a quiet mic the level check missed),
 * anything over a second goes anyway rather than losing what was said.
 */
export function sendLast(c: Clip, sentAny: boolean) {
  return c.speechMs >= 150 || (!sentAny && c.heldMs >= 1000);
}

/** RMS loudness of one analyser frame, 0 to about 1. */
export function loudness(samples: Float32Array) {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

/* ------------------------------- Audio -------------------------------- */

/** What whisper wants: 16 kHz mono. */
export const RATE = 16_000;
/** Kept from before the first word, so its start isn't clipped. */
export const PREROLL_MS = 300;
/** Shorter than this, a final clip is a click, not a word. */
export const MIN_CLIP_MS = 200;
/** A draft of the phrase so far, at most this often (one at a time). */
export const DRAFT_EVERY_MS = 450;

/**
 * Mic samples (48 or 44.1 kHz) → 16 kHz 16-bit, averaging each output
 * sample's span, which is filter enough for speech. Keeps its place across
 * calls, so chunks join seamlessly.
 */
export function downsampler(from: number) {
  const step = Math.max(1, from / RATE);
  let acc = 0;
  let n = 0;
  let pos = 0;
  return (input: Float32Array) => {
    const out = new Int16Array(Math.ceil(input.length / step) + 1);
    let k = 0;
    for (const s of input) {
      acc += s;
      n++;
      if (++pos >= step) {
        pos -= step;
        const v = Math.max(-1, Math.min(1, acc / n));
        out[k++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        acc = 0;
        n = 0;
      }
    }
    return out.subarray(0, k);
  };
}

/** 16 kHz mono 16-bit samples → a WAV file. */
export function wav(chunks: Int16Array[]) {
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new ArrayBuffer(44 + len * 2);
  const v = new DataView(buf);
  const tag = (at: number, s: string) =>
    [...s].forEach((ch, i) => v.setUint8(at + i, ch.charCodeAt(0)));
  tag(0, "RIFF");
  v.setUint32(4, 36 + len * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, len * 2, true);
  let at = 44;
  for (const c of chunks) {
    for (const x of c) {
      v.setInt16(at, x, true);
      at += 2;
    }
  }
  return new Blob([buf], { type: "audio/wav" });
}

/* ------------------------------- Text --------------------------------- */

/**
 * What whisper says when there was nothing to hear. Dropped only from clips
 * with little voice in them: a deliberate "thank you" is kept.
 */
const NOISE = new Set([
  "",
  "you",
  "thank you",
  "thanks",
  "thanks for watching",
  "thank you for watching",
  "bye",
  "okay",
  "so",
]);

export function worthTyping(text: string, speechMs: number) {
  const bare = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, "")
    .trim();
  if (!bare) return false;
  return speechMs >= 1200 || !NOISE.has(bare);
}

/** Text to type: one line, no control characters (Enter would send it). */
export function typeable(text: string) {
  return text
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
