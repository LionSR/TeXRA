// Host-neutral helper for applying theme classes onto <body> + <html>.
//
// Only the Electron renderer calls this: it is the host there, so it has to
// write the body signals itself. Inside VS Code the host writes them and the
// MutationObserver in `waColorScheme.ts` derives `wa-light`/`wa-dark` from
// them, so no webview code applies a theme by hand.
//
// The theme-kind vocabulary and the kind→darkness mapping live in
// `waColorScheme.ts` (the leaf this module already depends on); import them
// here rather than re-encoding a parallel copy.

import type { Theme } from '@shared/schemas';
import { setWaColorScheme, THEME_CLASSES, themeIsDark } from './waColorScheme';

/**
 * Apply Electron-renderer-style host theme classes:
 *   - removes any prior `vscode-*` body classes
 *   - adds `vscode-<kind>`
 *   - sets `body.dataset.vscodeThemeKind`
 *   - swaps the `wa-light`/`wa-dark` class on <html> via setWaColorScheme()
 *
 * This is the desktop renderer's stand-in for the body signals VS Code sets
 * on its own webviews, so the shared observer classifies both hosts the same
 * way.
 */
export function applyHostBodyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const body = document.body;
  if (!body) return;
  body.classList.remove(...THEME_CLASSES);
  body.classList.add(`vscode-${theme}`);
  body.dataset.vscodeThemeKind = theme;
  setWaColorScheme(themeIsDark(theme));
}
