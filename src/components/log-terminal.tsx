"use client";

import "@xterm/xterm/css/xterm.css";

import type { Terminal } from "@xterm/xterm";
import { Check, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { execCopy } from "@/lib/clipboard";
import { CLOSE } from "@/lib/protocol";
import { terminalTheme } from "@/lib/terminal-theme";
import { touchScroll } from "@/lib/touch-scroll";

type Status = "connecting" | "live" | "done" | "missing" | "retrying";

/**
 * A run's output.log, read-only: the whole log so far, then new lines as
 * they land. Not a tmux pane; selecting text copies it on release.
 */
export function LogTerminal({
  jobId,
  runId,
  fontSize,
}: {
  jobId: string;
  runId: string;
  fontSize: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<{ fit(): void } | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [copied, setCopied] = useState(false);
  const initialFont = useRef(fontSize);

  useEffect(() => {
    const el = containerRef.current!;
    let disposed = false;
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanup = () => {};

    (async () => {
      const [
        { Terminal },
        { FitAddon },
        { WebLinksAddon },
        { Unicode11Addon },
      ] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-web-links"),
        import("@xterm/addon-unicode11"),
      ]);
      const family =
        getComputedStyle(document.documentElement)
          .getPropertyValue("--font-jetbrains-mono")
          .trim() || "monospace";
      await document.fonts
        .load(`${initialFont.current}px ${family}`)
        .catch(() => {});
      if (disposed) return;

      const term = new Terminal({
        fontFamily: `${family}, monospace`,
        fontSize: initialFont.current,
        lineHeight: 1.15,
        theme: terminalTheme,
        allowProposedApi: true,
        disableStdin: true,
        cursorInactiveStyle: "none",
        cursorStyle: "bar",
        cursorWidth: 1,
        // The log uses bare \n.
        convertEol: true,
        scrollback: 50_000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      const unicode = new Unicode11Addon();
      term.loadAddon(unicode);
      term.unicode.activeVersion = "11";
      term.open(el);
      termRef.current = term;
      fitRef.current = fit;
      if (el.clientWidth > 0) fit.fit();
      // Hide the cursor: nothing is typed here.
      term.write("\x1b[?25l");

      // Copy inside the release itself: Safari only allows it in a gesture.
      const listen = new AbortController();
      el.addEventListener(
        "pointerup",
        () => {
          const text = term.getSelection().trim();
          if (text && execCopy(text)) setCopied(true);
        },
        { capture: true, signal: listen.signal },
      );
      // Finger drags scroll with momentum, like the session terminals.
      touchScroll(el, term, listen.signal);

      const connect = () => {
        const proto = location.protocol === "https:" ? "wss" : "ws";
        const qs = new URLSearchParams({ job: jobId, run: runId });
        const socket = new WebSocket(
          `${proto}://${location.host}/ws/log?${qs}`,
        );
        ws = socket;
        socket.onopen = () => setStatus("live");
        socket.onmessage = (e) => term.write(e.data);
        socket.onclose = (e) => {
          if (disposed || ws !== socket) return;
          if (e.code === CLOSE.DETACHED) return setStatus("done");
          if (e.code === CLOSE.NO_SESSION) return setStatus("missing");
          // Dropped mid-run (server restart, phone asleep): start over.
          setStatus("retrying");
          retryTimer = setTimeout(() => {
            term.reset();
            term.write("\x1b[?25l");
            connect();
          }, 1500);
        };
      };

      let frame = 0;
      const observer = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          if (el.clientWidth > 0 && el.clientHeight > 0) fit.fit();
        });
      });
      observer.observe(el);

      cleanup = () => {
        listen.abort();
        observer.disconnect();
        cancelAnimationFrame(frame);
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
  }, [jobId, runId]);

  useEffect(() => {
    const term = termRef.current;
    if (!term || term.options.fontSize === fontSize) return;
    term.options.fontSize = fontSize;
    fitRef.current?.fit();
  }, [fontSize]);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  return (
    <div className="relative min-h-0 flex-1 bg-terminal">
      <div ref={containerRef} className="absolute inset-0 isolate pl-2" />
      {(status === "connecting" || status === "retrying") && (
        <div className="pointer-events-none absolute top-3 right-4 flex items-center gap-2 rounded-full border bg-card/90 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur">
          <LoaderCircle className="size-3.5 animate-spin" />
          {status === "connecting" ? "Loading log…" : "Reconnecting…"}
        </div>
      )}
      {status === "missing" && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          This run&apos;s log is gone.
        </div>
      )}
      {copied && (
        <div className="pointer-events-none absolute right-4 bottom-3 flex items-center gap-1.5 rounded-full border bg-card/90 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur">
          <Check className="size-3.5" /> Copied
        </div>
      )}
    </div>
  );
}
