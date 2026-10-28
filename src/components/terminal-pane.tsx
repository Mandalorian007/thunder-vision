"use client";

import "@xterm/xterm/css/xterm.css";

import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import {
  ArrowDownToLine,
  Check,
  Copy,
  LoaderCircle,
  Plug,
  Unplug,
} from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { execCopy } from "@/lib/clipboard";
import { dictationInput } from "@/lib/dictation";
import { CLOSE, type ClientMessage } from "@/lib/protocol";
import { terminalTheme } from "@/lib/terminal-theme";
import { touchScroll } from "@/lib/touch-scroll";
import { cn } from "@/lib/utils";
import type { TmuxSession } from "@/server/tmux";

type Status = "connecting" | "open" | "reconnecting" | "ended" | "missing";

export type PaneHandle = {
  send(data: string): void;
  focus(): void;
};

/** The on-screen text between two cells, as tmux selects it (inclusive). */
function screenText(
  term: Terminal,
  a: { col: number; row: number },
  b: { col: number; row: number },
) {
  const [from, to] =
    a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];
  const buf = term.buffer.active;
  let text = "";
  for (let row = from.row; row <= to.row; row++) {
    const line = buf.getLine(buf.viewportY + row);
    if (!line) break;
    const start = row === from.row ? from.col : 0;
    const end = row === to.row ? to.col + 1 : term.cols;
    text += line.translateToString(true, start, end).trimEnd();
    if (row < to.row && !buf.getLine(buf.viewportY + row + 1)?.isWrapped)
      text += "\n";
  }
  return text;
}

type Props = {
  session: string;
  active: boolean;
  fontSize: number;
  /** Sticky Ctrl from the mobile key bar: the next typed letter becomes ^letter. */
  ctrlRef: RefObject<boolean>;
  onCtrlConsumed(): void;
  register(session: string, handle: PaneHandle | null): void;
  /** tmux says the pane is in copy mode (scrolled back), as of the last poll. */
  inMode: boolean;
  onSessions(sessions: TmuxSession[]): void;
};

const MAX_BACKOFF_MS = 10_000;

export function TerminalPane({
  session,
  active,
  fontSize,
  ctrlRef,
  onCtrlConsumed,
  register,
  inMode,
  onSessions,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const reconnectRef = useRef<() => void>(() => {});
  const [status, setStatus] = useState<Status>("connecting");
  /** Text tmux copied: done once it's on the clipboard, else it waits for a tap. */
  const [copied, setCopied] = useState<{ text: string; done: boolean } | null>(
    null,
  );
  /**
   * What we just did, ahead of the next poll: scrolled up (into copy mode) or
   * asked to go back to live. Expires once the poll has caught up.
   */
  const [scrolled, setScrolled] = useState<{ back: boolean } | null>(null);

  // Callbacks change identity every render; the terminal is created once.
  const latest = useRef({ onCtrlConsumed, register, fontSize });
  useEffect(() => {
    latest.current = { onCtrlConsumed, register, fontSize };
  });

  useEffect(() => {
    const el = containerRef.current!;
    let disposed = false;
    let ws: WebSocket | null = null;
    let retry = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanup = () => {};

    const send = (msg: ClientMessage) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    (async () => {
      const [
        { Terminal },
        { FitAddon },
        { WebLinksAddon },
        { Unicode11Addon },
        { ClipboardAddon },
      ] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-web-links"),
        import("@xterm/addon-unicode11"),
        import("@xterm/addon-clipboard"),
      ]);

      // next/font gives the family a hashed name; xterm measures glyphs on
      // open, so the font must be loaded first or cells come out the wrong size.
      const family =
        getComputedStyle(document.documentElement)
          .getPropertyValue("--font-jetbrains-mono")
          .trim() || "monospace";
      await document.fonts
        .load(`${latest.current.fontSize}px ${family}`)
        .catch(() => {});
      if (disposed) return;

      const term = new Terminal({
        fontFamily: `${family}, monospace`,
        fontSize: latest.current.fontSize,
        lineHeight: 1.1,
        theme: terminalTheme,
        cursorBlink: true,
        allowProposedApi: true,
        macOptionIsMeta: true,
        scrollback: 5000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());

      // OSC 52: tmux (mouse drag, copy mode) and Claude copy to your
      // clipboard; tmux leaves the selection field empty, so take any. Reads
      // answer "": nothing printed in a terminal can pull your clipboard in.
      //
      // Safari (so every iPad browser) only writes the clipboard inside a
      // click or tap, and tmux's copy arrives over the socket just after the
      // release. So releasing a drag copies the same cells from the screen
      // right away; tmux's copy only matters if it differs (say, a selection
      // that scrolled), and then gets a Copy button if the browser balks.
      let dragCopy: { text: string; at: number } | null = null;
      term.loadAddon(
        new ClipboardAddon(undefined, {
          readText: () => "",
          writeText: (_sel, text) => {
            if (!text) return;
            const recent = dragCopy && performance.now() - dragCopy.at < 2000;
            if (recent && dragCopy?.text === text) {
              dragCopy = null;
              return;
            }
            dragCopy = null;
            let settled = false;
            const ask = setTimeout(() => {
              if (!settled) setCopied({ text, done: false });
            }, 1000);
            navigator.clipboard.writeText(text).then(
              () => {
                settled = true;
                clearTimeout(ask);
                setCopied({ text, done: true });
              },
              () => {
                settled = true;
                clearTimeout(ask);
                setCopied({ text, done: false });
              },
            );
          },
        }),
      );
      const listen = new AbortController();
      const cellAt = (e: PointerEvent) => {
        const screen = el.querySelector(".xterm-screen");
        if (!screen) return null;
        const r = screen.getBoundingClientRect();
        const clamp = (n: number, max: number) =>
          Math.min(Math.max(Math.floor(n), 0), max - 1);
        return {
          col: clamp(((e.clientX - r.left) / r.width) * term.cols, term.cols),
          row: clamp(((e.clientY - r.top) / r.height) * term.rows, term.rows),
        };
      };
      let down: { col: number; row: number; x: number; y: number } | null =
        null;
      el.addEventListener(
        "pointerdown",
        (e) => {
          // A finger drag scrolls instead (touchScroll below).
          const cell =
            e.button === 0 && e.pointerType !== "touch" ? cellAt(e) : null;
          down = cell && { ...cell, x: e.clientX, y: e.clientY };
        },
        { capture: true, signal: listen.signal },
      );
      el.addEventListener(
        "pointerup",
        (e) => {
          const from = down;
          down = null;
          const to = cellAt(e);
          if (!from || !to) return;
          if (Math.hypot(e.clientX - from.x, e.clientY - from.y) < 5) return;
          const text = screenText(term, from, to);
          if (!text.trim()) return;
          const ok = execCopy(text);
          if (!ok) return;
          dragCopy = { text, at: performance.now() };
          setCopied({ text, done: true });
        },
        { capture: true, signal: listen.signal },
      );
      // Scrolling up with tmux's mouse on enters copy mode; offer a way back.
      const scrolledUp = () => {
        if (term.modes.mouseTrackingMode === "none") return;
        setScrolled((s) => (s?.back ? s : { back: true }));
      };
      touchScroll(el, term, listen.signal, (direction) => {
        if (direction < 0) scrolledUp();
      });
      dictationInput(el, term, listen.signal);
      el.addEventListener(
        "wheel",
        (e) => {
          if (e.deltaY < 0) scrolledUp();
        },
        { capture: true, passive: true, signal: listen.signal },
      );
      const unicode = new Unicode11Addon();
      term.loadAddon(unicode);
      term.unicode.activeVersion = "11";
      term.open(el);

      try {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // DOM renderer is fine.
      }

      if (disposed) {
        term.dispose();
        return;
      }
      termRef.current = term;
      fitRef.current = fit;
      if (el.clientWidth > 0) fit.fit();

      term.onData((data) => {
        if (ctrlRef.current && data.length === 1) {
          const code = data.toUpperCase().charCodeAt(0);
          if (code >= 64 && code <= 95) {
            data = String.fromCharCode(code - 64);
            latest.current.onCtrlConsumed();
          }
        }
        send({ t: "i", d: data });
      });
      term.onResize(({ cols, rows }) => send({ t: "r", cols, rows }));

      const connect = () => {
        clearTimeout(retryTimer);
        ws?.close();
        const proto = location.protocol === "https:" ? "wss" : "ws";
        const qs = new URLSearchParams({
          session,
          cols: String(term.cols),
          rows: String(term.rows),
        });
        const socket = new WebSocket(
          `${proto}://${location.host}/ws/pty?${qs}`,
        );
        ws = socket;
        setStatus(retry === 0 ? "connecting" : "reconnecting");

        socket.onopen = () => {
          retry = 0;
          setStatus("open");
        };
        socket.onmessage = (e) => term.write(e.data);
        socket.onclose = (e) => {
          if (disposed || ws !== socket) return;
          if (e.code === CLOSE.DETACHED) return setStatus("ended");
          if (e.code === CLOSE.NO_SESSION) return setStatus("missing");
          setStatus("reconnecting");
          const delay = Math.min(500 * 2 ** retry++, MAX_BACKOFF_MS);
          retryTimer = setTimeout(reconnect, delay);
        };
      };

      // tmux repaints the whole screen on attach, so start from a clean slate.
      const reconnect = () => {
        term.reset();
        connect();
      };
      reconnectRef.current = () => {
        retry = 0;
        reconnect();
      };

      // Phones kill sockets in the background; reconnect as soon as we're back.
      const onVisible = () => {
        if (
          document.visibilityState === "visible" &&
          ws?.readyState !== WebSocket.OPEN
        ) {
          reconnectRef.current();
        }
      };
      document.addEventListener("visibilitychange", onVisible);

      let frame = 0;
      const observer = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          if (el.clientWidth > 0 && el.clientHeight > 0) fit.fit();
        });
      });
      observer.observe(el);

      latest.current.register(session, {
        send: (data) => send({ t: "i", d: data }),
        focus: () => term.focus(),
      });

      cleanup = () => {
        listen.abort();
        document.removeEventListener("visibilitychange", onVisible);
        observer.disconnect();
        cancelAnimationFrame(frame);
        latest.current.register(session, null);
        term.dispose();
      };

      connect();
    })();

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      ws?.close();
      cleanup();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [session, ctrlRef]);

  useEffect(() => {
    if (!scrolled) return;
    const id = setTimeout(() => setScrolled(null), 3000);
    return () => clearTimeout(id);
  }, [scrolled]);

  const backToLive = async () => {
    setScrolled({ back: false });
    const res = await fetch("/api/sessions/live", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: session }),
    }).catch(() => null);
    if (res?.ok) onSessions((await res.json()).sessions);
  };
  const showLive = status === "open" && (scrolled ? scrolled.back : inMode);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(null), copied.done ? 1500 : 10_000);
    return () => clearTimeout(id);
  }, [copied]);

  const copyNow = (text: string) => {
    const ok = execCopy(text);
    if (ok) setCopied({ text, done: true });
    else
      navigator.clipboard.writeText(text).then(
        () => setCopied({ text, done: true }),
        () => setCopied(null),
      );
    // Not on touch: focusing the terminal pops the iOS keyboard.
    if (!matchMedia("(pointer: coarse)").matches) termRef.current?.focus();
  };

  useEffect(() => {
    const term = termRef.current;
    if (!term || term.options.fontSize === fontSize) return;
    term.options.fontSize = fontSize;
    fitRef.current?.fit();
  }, [fontSize]);

  useEffect(() => {
    if (!active) return;
    // Becoming visible: re-measure (hidden panes have no size) and grab focus.
    const id = requestAnimationFrame(() => {
      if (containerRef.current?.clientWidth) fitRef.current?.fit();
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [active, status]);

  return (
    <div
      className={cn("relative min-h-0 flex-1 bg-terminal", !active && "hidden")}
    >
      {/* isolate: xterm's layers (z-index up to 11) stay under our overlays. */}
      <div ref={containerRef} className="absolute inset-0 isolate" />

      {(status === "connecting" || status === "reconnecting") && (
        <div className="pointer-events-none absolute top-3 right-4 flex items-center gap-2 rounded-full border bg-card/90 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur">
          <LoaderCircle className="size-3.5 animate-spin" />
          {status === "connecting" ? "Attaching…" : "Reconnecting…"}
        </div>
      )}

      {showLive && (
        <Button
          size="sm"
          variant="secondary"
          className="absolute bottom-9 left-1/2 -translate-x-1/2 rounded-full shadow-sm pointer-coarse:h-10 pointer-coarse:px-4"
          onClick={backToLive}
        >
          <ArrowDownToLine /> Back to live
        </Button>
      )}

      {copied &&
        (copied.done ? (
          <div className="pointer-events-none absolute right-4 bottom-3 flex items-center gap-1.5 rounded-full border bg-card/90 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur">
            <Check className="size-3.5" /> Copied
          </div>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            className="absolute right-4 bottom-3 shadow-sm"
            onClick={() => copyNow(copied.text)}
          >
            <Copy /> Copy
          </Button>
        ))}

      {(status === "ended" || status === "missing") && (
        <div className="absolute inset-0 flex items-center justify-center bg-terminal/80 backdrop-blur-sm">
          <div className="flex max-w-sm flex-col items-center gap-3 rounded-xl border bg-card p-6 text-center shadow-lg">
            <Unplug className="size-6 text-muted-foreground" />
            <div>
              <p className="font-medium">
                {status === "ended" ? "Detached" : "Session not found"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {status === "ended" ? (
                  <>
                    The tmux client for{" "}
                    <span className="font-mono">{session}</span> exited.
                  </>
                ) : (
                  <>
                    <span className="font-mono">{session}</span> is no longer
                    running.
                  </>
                )}
              </p>
            </div>
            <Button size="sm" onClick={() => reconnectRef.current()}>
              <Plug /> Reattach
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
