/**
 * Detect terminal capability for DEC 2026 synchronized output.
 * Reference: Claude Code src/ink/terminal.ts
 */

/** Whether the terminal supports DEC 2026 synchronized output (BSU/ESU) */
export function isSynchronizedOutputSupported(): boolean {
  // tmux proxies but does not implement DEC 2026, breaks atomicity
  if (process.env.TMUX) return false;

  const termProgram = process.env.TERM_PROGRAM ?? "";
  const term = process.env.TERM ?? "";

  // Known terminals with DEC 2026 support
  const supported = [
    "iTerm.app",
    "WezTerm",
    "WarpTerminal",
    "ghostty",
    "contour",
    "vscode",
    "alacritty",
  ];
  if (supported.includes(termProgram)) return true;

  // kitty
  if (term.includes("kitty") || process.env.KITTY_WINDOW_ID) return true;

  // ghostty via TERM
  if (term === "xterm-ghostty") return true;

  // foot terminal
  if (term.startsWith("foot")) return true;

  // alacritty via TERM
  if (term.includes("alacritty")) return true;

  // Zed editor
  if (process.env.ZED_TERM) return true;

  // Windows Terminal
  if (process.env.WT_SESSION) return true;

  // VTE-based terminals (GNOME Terminal, Tilix, etc.) >= 6800
  const vte = process.env.VTE_VERSION;
  if (vte && parseInt(vte, 10) >= 6800) return true;

  return false;
}

/** Whether running inside tmux control mode (iTerm2 integration) */
export function isTmuxCC(): boolean {
  return !!(process.env.TMUX && process.env.TERM_PROGRAM === "tmux");
}
