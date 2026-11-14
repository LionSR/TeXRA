// Terminal-safe Unicode glyphs shared across the Ink TUI. Font Awesome (the
// webview/desktop icon set) is not available in a terminal, so the TUI renders
// these single-column glyphs directly. They are intentionally plain, stable
// codepoints — NOT the `figures` package, whose `pointer`/`tick` resolve to
// `❯`/`✔` and would change the established look.
//
// Centralized here so every list/select/prompt uses the same marker instead of
// re-declaring the literal in each component.

/** Focused-row marker for selects, palettes, pickers, and prompts. */
export const POINTER = '›';

/** Active/checked marker for selectable values. */
export const TICK = '✓';

/** Generated-token marker, prefixed to a compact token count (`↓1.2k`). */
export const TOKENS_GENERATED = '↓';

/** Status dot for tool rows and subagent rows; the on-beat of the approval pulse. */
export const STATUS_DOT = '●';

/** Decorative brand marker at the head of the status bar (aria-hidden). */
export const STATUS_DIAMOND = '◆';

/** Warning marker for inline failure notices (e.g. render-error fallback). */
export const WARNING = '⚠';

/** Heading marker for a round's results in the document task run details. */
export const PENDING_BOX = '□';

/** Terminal-failure marker; the ✗/✓ counterpart to TICK. */
export const CROSS = '✗';

/** Work deliberately not done: a user skip or a task the run never reached. */
export const SKIP_CIRCLE = '⊘';

/** Hollow dot: the off beat of a pulse, and a step queued but not started. */
export const HOLLOW_DOT = '○';

/** Script-call states beside the shared ones: half-filled while running,
 *  dashed when interrupted, a loop for a result reused from an earlier run,
 *  and a middle dot for a call the script never reached. */
export const RUNNING_HALF = '◐';
export const INTERRUPTED_CIRCLE = '◌';
export const REUSED = '↺';
export const NOT_RUN = '·';

/** Inline separator between facts on one line and between key hints. */
export const SEPARATOR = ' · ';

/** Unordered list item marker, also a neutral static-row bullet. */
export const LIST_BULLET = '•';

/** Blockquote gutter, repeated per nesting level (trailing space included). */
export const QUOTE_BAR = '│ ';

/** Horizontal rule segment. */
export const RULE = '─';

/** Text caret drawn in place of reverse video when color is off. */
export const GLYPH_CARET = '▏';

/** Disclosure markers for a collapsible tree row. */
export const EXPANDED = '▾';
export const COLLAPSED = '▸';

/** Transcript row prefixes (trailing space included for the gutter). User rows
 *  (and the default fallback) reuse the same chevron as selects (POINTER) so the
 *  look stays consistent; error rows use a bang. Assistant rows carry no prefix
 *  — they render as plain Markdown; local notices lead with a dim chevron so
 *  they cannot pass for them. */
export const USER_ENTRY_PREFIX = `${POINTER} `;
export const ERROR_ENTRY_PREFIX = '! ';
/** Local notice rows (a slash command's result): dim, never model text. */
export const NOTICE_ENTRY_PREFIX = '» ';

/** Corner glyph that opens each tool-output block. */
export const TOOL_OUTPUT_CORNER = '⎿';
