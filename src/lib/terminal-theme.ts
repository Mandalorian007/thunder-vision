import type { ITheme } from "@xterm/xterm";

/**
 * Cosmic Night (tweakcn) dark tokens converted to hex, plus a matching ANSI
 * palette. The terminal stays dark in light mode so Claude Code's dark-theme
 * colors stay legible.
 */
export const terminalTheme: ITheme = {
  background: "#0f0f1a",
  foreground: "#e2e2f5",
  cursor: "#a48fff",
  cursorAccent: "#0f0f1a",
  selectionBackground: "#a48fff55",
  selectionInactiveBackground: "#30306088",
  scrollbarSliderBackground: "#30305288",
  scrollbarSliderHoverBackground: "#303060",
  scrollbarSliderActiveBackground: "#a48fff88",

  black: "#1a1a2e",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#fbd530",
  blue: "#7aa2f7",
  magenta: "#a48fff",
  cyan: "#7dcfff",
  white: "#c0c0dd",
  brightBlack: "#565680",
  brightRed: "#ff8fa3",
  brightGreen: "#b9f27c",
  brightYellow: "#ffe57a",
  brightBlue: "#9ab8ff",
  brightMagenta: "#c4b5ff",
  brightCyan: "#a4e0ff",
  brightWhite: "#f4f4ff",
};
