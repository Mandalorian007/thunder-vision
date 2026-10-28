/** Messages the browser sends over /ws/pty. Server output is raw text frames. */
export type ClientMessage =
  | { t: "i"; d: string } // keystrokes / pasted input
  | { t: "r"; cols: number; rows: number }; // terminal resized

/** Close codes the client uses to decide whether to reconnect. */
export const CLOSE = {
  /** tmux client exited: session killed or detached with prefix+d. */
  DETACHED: 4000,
  NO_SESSION: 4404,
  FORBIDDEN: 4403,
} as const;
