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
