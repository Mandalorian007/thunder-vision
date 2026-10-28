/**
 * Copies synchronously, so it works inside a click or tap on Safari, where
 * navigator.clipboard writes can stay pending forever. readOnly keeps the
 * iOS keyboard down.
 */
export function execCopy(text: string) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.readOnly = true;
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px";
  const prev = document.activeElement;
  document.body.append(ta);
  ta.focus({ preventScroll: true });
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {}
  ta.remove();
  // Hand focus back (the terminal, after a drag). It had it already, so this
  // doesn't newly pop the iOS keyboard.
  if (prev instanceof HTMLElement && prev !== document.body)
    prev.focus({ preventScroll: true });
  return ok;
}

/** execCopy, falling back to the async API where execCommand is refused. */
export async function copyText(text: string) {
  if (execCopy(text)) return true;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
