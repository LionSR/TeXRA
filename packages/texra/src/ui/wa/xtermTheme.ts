/**
 * Resolve an xterm.js theme from Web Awesome CSS tokens on a host element.
 * Extension and desktop both call this with their own DOM target so the
 * terminal matches the active theme instead of a second hardcoded palette.
 *
 * Every host defines the terminal background and foreground (the trace
 * viewer through the desktop's bridge). An empty one means the host maps it
 * to a variable it never injects: a host bug, named once per terminal, with
 * no colour invented in its place (xterm keeps its own default for that key).
 */

/** The generic family when the host names no monospace font. */
const FALLBACK_FONT_FAMILY = 'monospace';

/** Terminal tokens every host defines. */
const REQUIRED_COLOR_TOKENS = [
  ['background', '--wa-color-terminal-background'],
  ['foreground', '--wa-color-terminal-foreground'],
] as const;

/** Web Awesome terminal ANSI color tokens mapped to xterm.js theme keys. */
const XTERM_ANSI_COLOR_TOKENS = [
  ['black', '--wa-color-terminal-ansi-black'],
  ['red', '--wa-color-terminal-ansi-red'],
  ['green', '--wa-color-terminal-ansi-green'],
  ['yellow', '--wa-color-terminal-ansi-yellow'],
  ['blue', '--wa-color-terminal-ansi-blue'],
  ['magenta', '--wa-color-terminal-ansi-magenta'],
  ['cyan', '--wa-color-terminal-ansi-cyan'],
  ['white', '--wa-color-terminal-ansi-white'],
  ['brightBlack', '--wa-color-terminal-ansi-bright-black'],
  ['brightRed', '--wa-color-terminal-ansi-bright-red'],
  ['brightGreen', '--wa-color-terminal-ansi-bright-green'],
  ['brightYellow', '--wa-color-terminal-ansi-bright-yellow'],
  ['brightBlue', '--wa-color-terminal-ansi-bright-blue'],
  ['brightMagenta', '--wa-color-terminal-ansi-bright-magenta'],
  ['brightCyan', '--wa-color-terminal-ansi-bright-cyan'],
  ['brightWhite', '--wa-color-terminal-ansi-bright-white'],
] as const;

interface ResolvedXtermTheme {
  readonly theme: Record<string, string>;
  readonly fontFamily: string;
}

/**
 * Read `--wa-*` tokens from `target` in one getComputedStyle call.
 * `reported` is the caller's record of the required tokens it already named
 * missing, so its theme refreshes do not repeat the warning.
 */
export function resolveXtermTheme(
  target: Element,
  reported: Set<string>,
): ResolvedXtermTheme {
  const styles = getComputedStyle(target);
  const token = (name: string): string => styles.getPropertyValue(name).trim();

  const theme: Record<string, string> = {};
  for (const [key, cssVar] of REQUIRED_COLOR_TOKENS) {
    const value = token(cssVar);
    if (value) theme[key] = value;
    else if (!reported.has(cssVar)) {
      reported.add(cssVar);
      console.warn(
        `[xtermTheme] ${cssVar} did not resolve: the host maps it to a variable it never injected. The terminal keeps xterm's default ${key}.`,
      );
    }
  }

  for (const [key, cssVar] of XTERM_ANSI_COLOR_TOKENS) {
    const value = token(cssVar);
    if (value) theme[key] = value;
  }

  // A host that names no cursor colour gets the text colour, as xterm's own
  // default does.
  const cursor = token('--wa-color-terminal-cursor') || theme.foreground;
  if (cursor) theme.cursor = cursor;

  const selectionBackground = token('--wa-color-terminal-selection-bg');
  if (selectionBackground) theme.selectionBackground = selectionBackground;

  return {
    theme,
    fontFamily: token('--wa-font-family-mono') || FALLBACK_FONT_FAMILY,
  };
}
