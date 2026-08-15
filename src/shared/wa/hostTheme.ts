// Host-neutral helpers for applying theme classes onto <body> + <html>.
//
// Both hosts (VS Code BaseWebviewApp and the Electron renderer) used to
// hand-roll body.classList mutation + setWaColorScheme() in lockstep. Keep
// the class names + ordering in one place so any future addition (e.g.
// `wa-high-contrast`) doesn't need parallel edits across hosts.
//
// The theme-kind vocabulary and the kind→darkness mapping live in
// `waColorScheme.ts` (the leaf this module already depends on); import them
// here rather than re-encoding a parallel copy.

import type { Theme } from '@shared/schemas';
import { setWaColorScheme, THEME_CLASSES, themeIsDark } from './waColorScheme';

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
