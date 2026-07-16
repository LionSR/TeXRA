// Terminal-safe Unicode glyphs shared across the Ink TUI. Font Awesome (the
// webview/desktop icon set) is not available in a terminal, so the TUI renders
// these single-column glyphs directly. They are intentionally plain, stable
// codepoints — NOT the `figures` package, whose `pointer`/`tick` resolve to
// `❯`/`✔` and would change the established look — picked per
// docs/prds/cli-tui-ink/10-architecture.md § Intuitiveness conventions.
//
// Centralized here so every list/select/prompt uses the same marker instead of
// re-declaring the literal in each component.

/** Focused-row marker for selects, palettes, pickers, and prompts. */
export const POINTER = '›';

/** Active/checked marker for selectable values. */
export const TICK = '✓';

/** Steady status dot for tool rows and subagent rows (never animated). */
export const STATUS_DOT = '●';

/** Decorative brand marker at the head of the status bar (aria-hidden). */
export const STATUS_DIAMOND = '◆';

/** Warning marker for inline failure notices (e.g. render-error fallback). */
export const WARNING = '⚠';

// Todo checklist markers. Completed / in-progress / pending (default).
export const TODO_DONE = '☑';
export const TODO_ACTIVE = '☐';
export const TODO_PENDING = '□';

/** Transcript row prefixes (trailing space included for the gutter). User rows
 *  (and the default fallback) reuse the same chevron as selects (POINTER) so the
 *  look stays consistent; error rows use a bang. Assistant rows carry no prefix
 *  — they render as plain Markdown. */
export const USER_ENTRY_PREFIX = `${POINTER} `;
export const ERROR_ENTRY_PREFIX = '! ';

/** Corner glyph that opens each tool-output block. */
export const TOOL_OUTPUT_CORNER = '⎿';

/** Marker for the liveness row shown while a run is active. */
export const THINKING_MARKER = '✻';
