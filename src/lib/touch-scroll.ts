import type { Terminal } from "@xterm/xterm";

/** tmux scrolls copy mode 5 lines per wheel click (its default bindings). */
const TMUX_LINES_PER_CLICK = 5;
/** Movement before a touch counts as a scroll rather than a tap. */
const SLOP_PX = 8;
/** Momentum decay per 16ms frame, and the speed (px/ms) where it stops. */
const FRICTION = 0.95;
const MIN_SPEED = 0.03;

/**
 * One-finger drags scroll the terminal, with momentum. xterm.js only scrolls
 * its own buffer on touch, which tmux leaves empty, so a drag did nothing.
 * Here it becomes what a trackpad would send: wheel clicks to the app when it
 * asked for the mouse (tmux with `mouse on` scrolls into copy mode), else the
 * scrollback scrolls. `onScroll` gets -1 per click up (into history), 1 down.
 */
export function touchScroll(
  el: HTMLElement,
  term: Terminal,
  signal: AbortSignal,
  onScroll?: (direction: -1 | 1) => void,
) {
  let start: { x: number; y: number } | null = null;
  let last = { y: 0, t: 0 };
  let scrolling = false;
  /** Finger travel not yet turned into lines; + is towards history. */
  let carry = 0;
  let speed = 0;
  let frame = 0;
  let at = { x: 0, y: 0 };

  const screen = () => el.querySelector<HTMLElement>(".xterm-screen");
  const cellHeight = () => {
    const s = screen();
    return s && term.rows ? s.getBoundingClientRect().height / term.rows : 16;
  };
  const mouseApp = () => term.modes.mouseTrackingMode !== "none";
  const step = () => cellHeight() * (mouseApp() ? TMUX_LINES_PER_CLICK : 1);

  /** One click (or line) up into history (-1) or back down (1). */
  const scroll = (direction: -1 | 1) => {
    onScroll?.(direction);
    if (!mouseApp() && term.buffer.active.type === "normal") {
      term.scrollLines(direction);
      return;
    }
    // xterm encodes it for the app: a mouse wheel report, or arrow keys.
    const s = screen();
    const r = s?.getBoundingClientRect();
    if (!s || !r) return;
    s.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: direction,
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        clientX: Math.min(Math.max(at.x, r.left + 1), r.right - 1),
        clientY: Math.min(Math.max(at.y, r.top + 1), r.bottom - 1),
        bubbles: true,
        cancelable: true,
      }),
    );
  };

  const consume = () => {
    const unit = step();
    while (Math.abs(carry) >= unit) {
      scroll(carry > 0 ? -1 : 1);
      carry -= Math.sign(carry) * unit;
    }
  };

  const glide = (prev: number) => (now: number) => {
    const dt = Math.min(now - prev, 50);
    carry += speed * dt;
    consume();
    speed *= FRICTION ** (dt / 16);
    frame = Math.abs(speed) > MIN_SPEED ? requestAnimationFrame(glide(now)) : 0;
  };

  const opts = { capture: true, signal };
  el.addEventListener(
    "touchstart",
    (e) => {
      cancelAnimationFrame(frame);
      speed = 0;
      if (e.touches.length !== 1) {
        start = null;
        return;
      }
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY };
      at = { ...start };
      last = { y: t.clientY, t: e.timeStamp };
      scrolling = false;
      carry = 0;
      // Ours alone: xterm's own touch scrolling would fight it.
      e.stopPropagation();
    },
    { ...opts, passive: true },
  );
  el.addEventListener(
    "touchmove",
    (e) => {
      if (!start || e.touches.length !== 1) return;
      const t = e.touches[0];
      if (!scrolling) {
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        if (Math.abs(dy) < SLOP_PX || Math.abs(dy) < Math.abs(dx)) return;
        scrolling = true;
        last = { y: t.clientY, t: e.timeStamp };
      }
      e.preventDefault();
      e.stopPropagation();
      const dy = t.clientY - last.y;
      const dt = Math.max(e.timeStamp - last.t, 1);
      // Smoothed, so one jittery sample doesn't decide the fling.
      speed = 0.8 * (dy / dt) + 0.2 * speed;
      last = { y: t.clientY, t: e.timeStamp };
      carry += dy;
      consume();
    },
    { ...opts, passive: false },
  );
  el.addEventListener(
    "touchend",
    (e) => {
      if (!start) return;
      start = null;
      if (!scrolling) return;
      e.stopPropagation();
      // A finger that stopped before lifting doesn't fling.
      if (e.timeStamp - last.t > 100) speed = 0;
      if (Math.abs(speed) > MIN_SPEED) {
        frame = requestAnimationFrame((now) => glide(now)(now));
      }
    },
    opts,
  );
  el.addEventListener(
    "touchcancel",
    () => {
      start = null;
      speed = 0;
    },
    opts,
  );
  signal.addEventListener("abort", () => cancelAnimationFrame(frame));
}
