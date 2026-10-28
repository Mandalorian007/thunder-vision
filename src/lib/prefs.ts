"use client";

import { useCallback, useSyncExternalStore } from "react";

// A tiny external store so URL hash and localStorage prefs hydrate cleanly.
const listeners = new Set<() => void>();
export const notify = () => listeners.forEach((l) => l());
export function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("hashchange", listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("hashchange", listener);
    window.removeEventListener("storage", listener);
  };
}

/** Per-device preference. Storage may be blocked (private mode), so never trust it. */
export function usePref<T>(
  key: string,
  serverDefault: T,
  clientDefault: () => T,
) {
  const raw = useSyncExternalStore(
    subscribe,
    () => {
      try {
        const stored = localStorage.getItem(key);
        if (stored !== null) return stored;
      } catch {}
      return JSON.stringify(clientDefault());
    },
    () => JSON.stringify(serverDefault),
  );
  const set = useCallback(
    (next: T) => {
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {}
      notify();
    },
    [key],
  );
  return [JSON.parse(raw) as T, set] as const;
}
