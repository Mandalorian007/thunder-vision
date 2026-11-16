"use client";

import { LoaderCircle, Mic } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  type Clip,
  DRAFT_EVERY_MS,
  downsampler,
  fresh,
  type Gesture,
  idle,
  listen,
  loudness,
  MIN_CLIP_MS,
  MIN_SPEECH_MS,
  PREROLL_MS,
  press,
  RATE,
  sendLast,
  typeable,
  wav,
  worthTyping,
} from "@/lib/voice";

/* ------------------------------ Caption ------------------------------- */

// What's been heard but not typed yet: the live draft of the phrase you're
// saying, and earlier phrases still on their final pass. Shown over the
// terminal so you can see it working; each leaves as its final text is typed.
// Keyed by phrase, in the order spoken.
const heard = new Map<number, string>();
const listeners = new Set<() => void>();
let caption = "";
function publish() {
  caption = [...heard.values()].filter(Boolean).join(" ");
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function VoiceCaption() {
  const text = useSyncExternalStore(
    subscribe,
    () => caption,
    () => "",
  );
  if (!text) return null;
  return (
    <div className="pointer-events-none absolute top-2 right-2 left-2 z-20 flex justify-end">
      <p
        aria-live="polite"
        className="max-w-xl rounded-lg border bg-background/90 px-3 py-2 text-sm text-muted-foreground shadow-lg backdrop-blur pointer-coarse:text-base"
      >
        {text}
        <span className="ml-0.5 inline-block w-1.5 animate-pulse text-red-500">
          ▍
        </span>
      </p>
    </div>
  );
}

/* ------------------------------ Capture ------------------------------- */

// Passes the mic's samples out of the audio thread, ~40ms at a time.
const TAP = `registerProcessor("tv-tap", class extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf);
        this.buf = new Float32Array(2048);
        this.n = 0;
      }
    }
    return true;
  }
});`;
let tapUrl: string | undefined;

/** Calls `onAudio` with each chunk of mic samples until the context closes. */
async function tap(
  ctx: AudioContext,
  stream: MediaStream,
  onAudio: (samples: Float32Array) => void,
) {
  const src = ctx.createMediaStreamSource(stream);
  // Silent, but connected: some browsers only run nodes that reach the end.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  mute.connect(ctx.destination);
  try {
    tapUrl ??= URL.createObjectURL(
      new Blob([TAP], { type: "text/javascript" }),
    );
    await ctx.audioWorklet.addModule(tapUrl);
    const node = new AudioWorkletNode(ctx, "tv-tap");
    node.port.onmessage = (e: MessageEvent<Float32Array>) => onAudio(e.data);
    src.connect(node).connect(mute);
  } catch {
    // Older Safari: the deprecated way, on the main thread.
    const node = ctx.createScriptProcessor(2048, 1, 1);
    node.onaudioprocess = (e) =>
      onAudio(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(node).connect(mute);
  }
}

/* ------------------------------- Button ------------------------------- */

let nextId = 0;

/** One phrase: the audio between two pauses. */
type Phrase = {
  id: number;
  chunks: Int16Array[];
  samples: number;
  /** Samples the latest draft covered. */
  drafted: number;
};

const phrase = (): Phrase => {
  const p = { id: nextId++, chunks: [], samples: 0, drafted: 0 };
  heard.set(p.id, "");
  return p;
};

const forget = (id: number) => heard.delete(id) && publish();

type Recording = {
  /** Set once stopped, even mid-permission-prompt. */
  over: boolean;
  ctx: AudioContext;
  stream?: MediaStream;
  clip: Clip;
  phrase: Phrase;
  drafting: boolean;
  lastDraft: number;
  /** No draft server: stop asking for this recording. */
  noDrafts: boolean;
  sentAny: boolean;
  failed: boolean;
  sink(text: string): void;
};

async function transcribe(blob: Blob, draft: boolean) {
  const res = await fetch(`/api/transcribe${draft ? "?draft=1" : ""}`, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: blob,
  });
  const json = (await res.json().catch(() => ({}))) as {
    text?: string;
    error?: string;
  };
  if (!res.ok) {
    throw Object.assign(
      new Error(json.error ?? `Transcribing failed (${res.status})`),
      { status: res.status },
    );
  }
  return json.text ?? "";
}

/**
 * Talk into the terminal. Hold to talk and let go, or tap to start and tap
 * again to stop. While you talk, a quick draft of what you're saying shows
 * over the terminal; at each pause that phrase gets an accurate pass
 * (whisper.cpp on the Mac) and is typed in, in order, while you carry on.
 * Nothing is sent: Enter is still yours.
 */
export function VoiceButton({
  sink,
  className,
}: {
  /** Where this recording's text goes, fixed when it starts; null: nowhere. */
  sink(): ((text: string) => void) | null;
  className?: string;
}) {
  const gesture = useRef<Gesture>(idle);
  const current = useRef<Recording | null>(null);
  // Typing waits on the phrase before it, so phrases land in the order spoken.
  const chain = useRef<Promise<void>>(Promise.resolve());
  const [mode, setMode] = useState<"off" | "starting" | "on">("off");
  const [level, setLevel] = useState(0);
  const [pending, setPending] = useState(0);

  /** The final pass of a finished phrase, typed when its turn comes. */
  const send = (r: Recording, p: Phrase, speechMs: number) => {
    if ((p.samples / RATE) * 1000 < MIN_CLIP_MS) return forget(p.id);
    r.sentAny = true;
    setPending((n) => n + 1);
    const text = transcribe(wav(p.chunks), false);
    text.catch(() => {}); // Reported in order below.
    chain.current = chain.current.then(async () => {
      try {
        const said = typeable(await text);
        if (worthTyping(said, speechMs)) r.sink(`${said} `);
      } catch (err) {
        if (!r.failed) {
          r.failed = true;
          toast.error(
            err instanceof Error ? err.message : "Transcribing failed",
          );
        }
      } finally {
        forget(p.id);
        setPending((n) => n - 1);
      }
    });
  };

  /** A quick look at the phrase so far; one at a time, so it keeps pace. */
  const draft = (r: Recording, now: number) => {
    const p = r.phrase;
    if (
      r.noDrafts ||
      r.drafting ||
      now - r.lastDraft < DRAFT_EVERY_MS ||
      r.clip.speechMs < MIN_SPEECH_MS ||
      p.samples === p.drafted
    )
      return;
    r.drafting = true;
    r.lastDraft = now;
    p.drafted = p.samples;
    const speechMs = r.clip.speechMs;
    transcribe(wav(p.chunks), true)
      .then((text) => {
        const said = typeable(text);
        // Still waiting on its final? (A late draft mustn't reappear.)
        if (heard.has(p.id)) {
          heard.set(p.id, worthTyping(said, speechMs) ? said : "");
          publish();
        }
      })
      .catch((err: { status?: number }) => {
        if (err.status === 503 || err.status === 415) r.noDrafts = true;
      })
      .finally(() => (r.drafting = false));
  };

  const release = (r: Recording) => {
    r.stream?.getTracks().forEach((t) => t.stop());
    r.ctx.close().catch(() => {});
  };

  const stop = (r: Recording | null = current.current) => {
    gesture.current = idle;
    if (!r || r.over) return;
    r.over = true;
    current.current = null;
    setMode("off");
    setLevel(0);
    release(r);
    if (r.stream && sendLast(r.clip, r.sentAny)) {
      send(r, r.phrase, r.clip.speechMs);
    } else forget(r.phrase.id);
  };

  const start = async () => {
    const sink_ = sink();
    if (!sink_) {
      gesture.current = idle;
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
      gesture.current = idle;
      toast.error("No microphone here: open the https:// tailnet address");
      return;
    }
    // Load the models while the mic opens.
    fetch("/api/transcribe?warm=1", { method: "POST" }).catch(() => {});
    // Made inside the tap, or iOS keeps it suspended.
    const r: Recording = {
      over: false,
      ctx: new AudioContext(),
      clip: fresh,
      phrase: phrase(),
      drafting: false,
      lastDraft: 0,
      noDrafts: false,
      sentAny: false,
      failed: false,
      sink: sink_,
    };
    current.current = r;
    setMode("starting");
    r.ctx.resume().catch(() => {});
    try {
      r.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      if (!r.over) {
        toast.error(
          err instanceof DOMException && err.name === "NotAllowedError"
            ? "Microphone blocked: allow it for this site in Settings"
            : "Couldn't open the microphone",
        );
      }
      r.over = true;
      if (current.current === r) current.current = null;
      gesture.current = idle;
      setMode("off");
      forget(r.phrase.id);
      return release(r);
    }
    // Let go (or tapped off) while the permission prompt was up.
    if (r.over) return release(r);

    const down = downsampler(r.ctx.sampleRate);
    const preroll = (PREROLL_MS / 1000) * RATE;
    const onAudio = (samples: Float32Array) => {
      if (r.over) return;
      const ms = (samples.length / r.ctx.sampleRate) * 1000;
      const lvl = loudness(samples);
      const before = r.clip;
      const { c, act } = listen(before, lvl, ms);
      r.clip = c;
      setLevel(lvl);

      const p = r.phrase;
      const pcm = down(samples);
      p.chunks.push(pcm);
      p.samples += pcm.length;
      // Before the first word, keep only a moment of lead-in.
      if (c.speechMs === 0 && !act) {
        while (p.chunks.length > 1 && p.samples - p.chunks[0].length >= preroll)
          p.samples -= p.chunks.shift()!.length;
      }
      if (act) {
        r.phrase = phrase();
        if (act === "cut") send(r, p, before.speechMs);
        else forget(p.id);
      }
      draft(r, performance.now());
    };
    try {
      await tap(r.ctx, r.stream, onAudio);
    } catch {
      toast.error("Couldn't read the microphone");
      return stop(r);
    }
    if (r.over) return;
    setMode("on");
  };

  const touch = (t: "down" | "up") => {
    const { g, act } = press(gesture.current, t, performance.now());
    gesture.current = g;
    if (act === "start") start();
    else if (act === "stop") stop();
  };

  // A backgrounded tab loses the mic on iOS; finish cleanly instead.
  useEffect(() => {
    const onHide = () => document.visibilityState === "hidden" && stop();
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      const r = current.current;
      if (r) {
        r.over = true;
        forget(r.phrase.id);
        release(r);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const on = mode !== "off";
  const label = on ? "Stop talking" : "Talk (hold, or tap to start and stop)";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-pressed={on}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            // Keeps focus (and the iOS keyboard) where it was.
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            touch("down");
          }}
          onPointerUp={() => touch("up")}
          // Whatever was said still goes; losing it is the worse mistake.
          onPointerCancel={() => gesture.current.on && stop()}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            if (e.repeat) return;
            if (gesture.current.on) stop();
            else {
              gesture.current = { on: true, latched: true, since: 0 };
              start();
            }
          }}
          onContextMenu={(e) => e.preventDefault()}
          style={
            mode === "on"
              ? {
                  boxShadow: `0 0 0 ${Math.min(6, 1 + level * 150).toFixed(1)}px rgb(239 68 68 / 0.35)`,
                }
              : undefined
          }
          className={cn(
            "relative size-8 touch-none text-muted-foreground select-none [-webkit-touch-callout:none] pointer-coarse:size-10",
            on &&
              "bg-red-500/15 text-red-500 hover:bg-red-500/20 hover:text-red-500",
            mode === "starting" && "animate-pulse",
            className,
          )}
        >
          <Mic />
          {pending > 0 && (
            <LoaderCircle className="absolute -top-0.5 -right-0.5 size-3! animate-spin text-muted-foreground" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
