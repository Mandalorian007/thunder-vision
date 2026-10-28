"use client";

import "@xterm/xterm/css/xterm.css";

import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { LoaderCircle, Plug, Unplug } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { CLOSE, type ClientMessage } from "@/lib/protocol";
import { terminalTheme } from "@/lib/terminal-theme";
import { cn } from "@/lib/utils";

type Status = "connecting" | "open" | "reconnecting" | "ended" | "missing";

export type PaneHandle = {
  send(data: string): void;
  focus(): void;
};

type Props = {
  session: string;
  active: boolean;
  fontSize: number;
  /** Sticky Ctrl from the mobile key bar: the next typed letter becomes ^letter. */
  ctrlRef: RefObject<boolean>;
  onCtrlConsumed(): void;
  register(session: string, handle: PaneHandle | null): void;
};

const MAX_BACKOFF_MS = 10_000;

export function TerminalPane({
  session,
  active,
  fontSize,
  ctrlRef,
  onCtrlConsumed,
  register,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const reconnectRef = useRef<() => void>(() => {});
  const [status, setStatus] = useState<Status>("connecting");

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
      // OSC 52: tmux/Claude can copy to your clipboard. Reads answer "", so
      // nothing printed in a terminal can pull your clipboard into it.
      term.loadAddon(
        new ClipboardAddon(undefined, {
          readText: () => "",
          writeText: (sel, text) =>
            sel === "c" ? navigator.clipboard.writeText(text) : undefined,
        }),
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
      <div ref={containerRef} className="absolute inset-0" />

      {(status === "connecting" || status === "reconnecting") && (
        <div className="pointer-events-none absolute top-3 right-4 flex items-center gap-2 rounded-full border bg-card/90 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur">
          <LoaderCircle className="size-3.5 animate-spin" />
          {status === "connecting" ? "Attaching…" : "Reconnecting…"}
        </div>
      )}

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
