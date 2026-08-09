// Host-neutral helpers for applying theme classes onto <body> + <html>.
//
// Both hosts (VS Code BaseWebviewApp and the Electron renderer) used to
// hand-roll body.classList mutation + setWaColorScheme() in lockstep. Keep
// the class names + ordering in one place so any future addition (e.g.
// `wa-high-contrast`) doesn't need parallel edits across hosts.

import type { Theme } from '@shared/schemas/commonViewMessages';
import { setWaColorScheme } from './waColorScheme';

const THEME_KINDS = [
  'light',
  'dark',
  'high-contrast',
] as const satisfies readonly Theme[];

const THEME_CLASSES = THEME_KINDS.flatMap((kind) => [
  `vscode-${kind}`,
  `texra-${kind}`,
]);

/**
 * Convert a `Theme` kind to whether it should render as dark.
 * 'high-contrast' is treated as dark (matches the desktop theme tokens
 * and VS Code's dark-on-dark default for high-contrast themes).
 */
export function themeIsDark(theme: Theme): boolean {
  return theme === 'dark' || theme === 'high-contrast';
}

/**
 * Apply Electron-renderer-style host theme classes:
 *   - removes any prior `vscode-*` / `texra-*` body classes
 *   - adds `vscode-<kind>` AND `texra-<kind>`
 *   - sets `body.dataset.vscodeThemeKind`
 *   - swaps the `wa-light`/`wa-dark` class on <html> via setWaColorScheme()
 *
 * Equivalent to the desktop's `applyDesktopTheme()` and the VS Code
 * `BaseWebviewApp.onThemeChange()` body manipulation, just centralised.
 */
export function applyHostBodyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const body = document.body;
  if (!body) return;
  body.classList.remove(...THEME_CLASSES);
  body.classList.add(`vscode-${theme}`, `texra-${theme}`);
  body.dataset.vscodeThemeKind = theme;
  setWaColorScheme(themeIsDark(theme));
}
