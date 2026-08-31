/**
 * Resolve an xterm.js theme from Web Awesome CSS tokens on a host element.
 * Extension and desktop both call this with their own DOM target so the
 * terminal matches the active theme instead of a second hardcoded palette.
 *
 * Background and foreground prefer the dedicated terminal tokens so the
 * progress-view terminal matches the host integrated terminal. Surface and
 * text tokens remain fallbacks when a host omits the terminal pair, but the
 * fallback is loud: a token mapped to a variable the host never injects
 * resolves to '', and silently keeping the surface palette would mask that
 * broken mapping.
 */

const XTERM_THEME_FALLBACKS = {
  background: '#1e1e1e',
  foreground: '#cccccc',
  fontFamily: 'monospace',
} as const;

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

/** Read `--wa-*` tokens from `target` in one getComputedStyle call. */
export function resolveXtermTheme(target: Element): ResolvedXtermTheme {
  const styles = getComputedStyle(target);
  const token = (name: string): string => styles.getPropertyValue(name).trim();

  const terminalBackground = token('--wa-color-terminal-background');
  const terminalForeground = token('--wa-color-terminal-foreground');
  // Both hosts define the terminal pair, so an empty value means the mapping
  // points at a variable the host never injected (e.g. a --vscode-terminal-*
  // color absent from the webview). Name the missing tokens rather than let
  // the surface-palette fallback silently mask the broken mapping.
  const unresolved = [
    [terminalBackground, '--wa-color-terminal-background'],
    [terminalForeground, '--wa-color-terminal-foreground'],
  ]
    .filter(([value]) => !value)
    .map(([, name]) => name);
  if (unresolved.length > 0) {
    console.warn(
      `[xtermTheme] ${unresolved.join(', ')} did not resolve; falling back to the surface palette or built-in defaults.`,
    );
  }

  const theme: Record<string, string> = {
    background:
      terminalBackground ||
      token('--wa-color-surface-default') ||
      XTERM_THEME_FALLBACKS.background,
    foreground:
      terminalForeground ||
      token('--wa-color-text-normal') ||
      XTERM_THEME_FALLBACKS.foreground,
  };

  for (const [key, cssVar] of XTERM_ANSI_COLOR_TOKENS) {
    const value = token(cssVar);
    if (value) theme[key] = value;
  }

  // Dedicated cursor token first; `--wa-color-text-normal` next so a host
  // that omits the cursor token keeps the desktop high-contrast source
  // (CanvasText) rather than jumping to FieldText via input-foreground.
  theme.cursor =
    token('--wa-color-terminal-cursor') ||
    token('--wa-color-text-normal') ||
    theme.foreground;

  const selectionBackground = token('--wa-color-terminal-selection-bg');
  if (selectionBackground) theme.selectionBackground = selectionBackground;

  return {
    theme,
    fontFamily:
      token('--wa-font-family-mono') || XTERM_THEME_FALLBACKS.fontFamily,
  };
}
