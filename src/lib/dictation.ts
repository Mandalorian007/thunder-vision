import type { Terminal } from "@xterm/xterm";

/** Erases one character before the cursor, as Backspace does. */
const DEL = "\x7f";

/**
 * Text that arrives with no key behind it (iOS dictation, QuickType
 * suggestions, autocorrect) is sent as an edit of what's already typed.
 * Dictation keeps rewriting its guess in xterm's hidden textarea ("he",
 * "hell", "hello world"), and xterm sent each guess whole, so "hello world"
 * came out as "hehellhellohello world". Here only the change goes out:
 * backspaces over what was revised, then the new text. Key presses and IME
 * composition still go through xterm as before.
 */
export function dictationInput(
  el: HTMLElement,
  term: Terminal,
  signal: AbortSignal,
) {
  let keyed = false;
  let before: string | null = null;
  const opts = { capture: true, signal };
  const isTextarea = (t: EventTarget | null): t is HTMLTextAreaElement =>
    t === term.textarea && t !== undefined;

  el.addEventListener("keydown", () => (keyed = true), opts);
  el.addEventListener("keyup", () => (keyed = false), opts);
  el.addEventListener(
    "beforeinput",
    (e) => {
      before = isTextarea(e.target) ? e.target.value : null;
    },
    opts,
  );
  el.addEventListener(
    "input",
    (e) => {
      const ev = e as InputEvent;
      const old = before;
      before = null;
      if (
        keyed ||
        old === null ||
        !isTextarea(ev.target) ||
        ev.isComposing ||
        ev.inputType === "insertFromPaste" ||
        ev.inputType === "insertFromDrop"
      ) {
        return;
      }
      const prev = Array.from(old);
      const next = Array.from(ev.target.value);
      let same = 0;
      while (
        same < prev.length &&
        same < next.length &&
        prev[same] === next[same]
      ) {
        same++;
      }
      // Ours alone: xterm would send the whole guess again.
      e.stopPropagation();
      const data = DEL.repeat(prev.length - same) + next.slice(same).join("");
      if (data) term.input(data, true);
    },
    opts,
  );
}
