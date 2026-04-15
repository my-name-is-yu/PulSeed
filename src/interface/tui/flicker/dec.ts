// DEC Private Mode escape sequences for no-flicker rendering
// Reference: Claude Code src/ink/termio/dec.ts

/** Enter alternate screen buffer (DEC 1049 set) */
export const ENTER_ALT_SCREEN = "[?1049h";

/** Exit alternate screen buffer (DEC 1049 reset) */
export const EXIT_ALT_SCREEN = "[?1049l";

/** Begin Synchronized Update (DEC 2026 set) — terminal holds display */
export const BSU = "[?2026h";

/** End Synchronized Update (DEC 2026 reset) — terminal flushes display */
export const ESU = "[?2026l";

/** Move cursor to home position (0,0) */
export const CURSOR_HOME = "[H";

/** Erase entire screen */
export const ERASE_SCREEN = "[2J";

/** Erase current line */
export const ERASE_LINE = "[2K";

/** Hide cursor */
export const HIDE_CURSOR = "[?25l";

/** Show cursor */
export const SHOW_CURSOR = "[?25h";

/** Set cursor style to steady bar (DECSCUSR) */
export const STEADY_BAR_CURSOR = "[6 q";

/** Restore terminal default cursor style (DECSCUSR reset) */
export const DEFAULT_CURSOR_STYLE = "[0 q";

/** Enable SGR mouse tracking with drag events */
export const ENABLE_MOUSE_TRACKING = "[?1000h[?1002h[?1006h";

/** Disable SGR mouse tracking */
export const DISABLE_MOUSE_TRACKING = "[?1006l[?1002l[?1000l";

/** Build a cursor-park sequence for the given terminal row */
export function parkCursor(rows: number): string {
  return `[${rows};1H`;
}

/** Move cursor to the given row and column (1-based) */
export function cursorTo(row: number, col = 1): string {
  return `[${row};${col}H`;
}
