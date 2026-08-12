import type { Theme } from '@shared/schemas';
/**
 * Apply Web Awesome's native color-scheme classes (wa-light / wa-dark) onto
 * the document root, mirroring the host theme.
 *
 * Detection sources (in priority order):
 *   1. VS Code injects <body data-vscode-theme-kind="vscode-dark|vscode-light|
 *      vscode-high-contrast"> and adds vscode-* classes to <body>. We watch
 *      both attribute and class changes via MutationObserver.
 *   2. Desktop renderer (Electron) calls applyDesktopTheme() which also adds a
 *      vscode-<kind> class to <body>; the same observer picks that up.
 *   3. Fallback: prefers-color-scheme media query.
 *
 * The observer also keeps the html class in sync if the host swaps themes
 * mid-session (e.g. user toggles VS Code light/dark).
 *
 * This module is the single owner of the theme-kind vocabulary: the
 * kind→darkness mapping (`themeIsDark`) and the derived `vscode-*` / `texra-*`
 * body-class list (`THEME_CLASSES`) live here, and `hostTheme.ts` imports them
 * rather than re-encoding a parallel copy.
 */

/** The host theme kinds we recognize. Single source for the `vscode-*` /
 *  `texra-*` class names and the kind→darkness mapping. */
export const THEME_KINDS = [
  'light',
  'dark',
  'high-contrast',
] as const satisfies readonly Theme[];

/** Every `vscode-<kind>` / `texra-<kind>` body class, derived from THEME_KINDS.
 *  `applyHostBodyTheme` strips these on re-apply and `isDarkTheme` below
 *  classifies body classes against this same list. */
export const THEME_CLASSES: readonly string[] = THEME_KINDS.flatMap((kind) => [
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

const DARK_BODY_CLASSES: readonly string[] = THEME_KINDS.filter(
  themeIsDark,
).flatMap((kind) => [`vscode-${kind}`, `texra-${kind}`]);

const LIGHT_BODY_CLASSES: readonly string[] = [
  ...THEME_KINDS.filter((kind) => !themeIsDark(kind)).flatMap((kind) => [
    `vscode-${kind}`,
    `texra-${kind}`,
  ]),
  // VS Code's special light high-contrast class, not derivable from
  // THEME_KINDS (it is a theme variant, not a kind).
  'vscode-high-contrast-light',
];

let observer: MutationObserver | null = null;

function isDarkTheme(): boolean {
  const body = document.body;
  if (body) {
    if (DARK_BODY_CLASSES.some((name) => body.classList.contains(name))) {
      return true;
    }
    if (LIGHT_BODY_CLASSES.some((name) => body.classList.contains(name))) {
      return false;
    }
    // data-vscode-theme-kind carries the kind with or without the 'vscode-'
    // prefix; strip it and classify through the shared mapping. Unknown kinds
    // fall out as non-dark, matching the retired hand-rolled DARK_THEME_KINDS.
    const kind = body.dataset.vscodeThemeKind;
    if (kind) {
      const bare = kind.startsWith('vscode-')
        ? kind.slice('vscode-'.length)
        : kind;
      return themeIsDark(bare as Theme);
    }
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function syncWaClass(): void {
  const dark = isDarkTheme();
  // Only mutate when needed to avoid layout thrash when other observers run.
  const current = dark ? 'wa-dark' : 'wa-light';
  if (document.documentElement.classList.contains(current)) return;
  setWaColorScheme(dark);
}

/**
 * Imperatively swap the `wa-light`/`wa-dark` class on `<html>` to match the
 * provided dark/light intent. Both hosts (VS Code BaseWebviewApp and the
 * Electron renderer) used to hand-roll this two-line dance; centralising it
 * here keeps the class names + ordering in one place so any future addition
 * (e.g. `wa-high-contrast`) doesn't need parallel edits.
 */
export function setWaColorScheme(dark: boolean): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.remove('wa-light', 'wa-dark');
  root.classList.add(dark ? 'wa-dark' : 'wa-light');
}

export function applyInitialWaColorScheme(): void {
  if (typeof document === 'undefined') return;
  syncWaClass();
  if (observer) return;
  observer = new MutationObserver(syncWaClass);
  // Body may not exist yet if this module loads before <body> parses.
  const start = (): void => {
    if (!document.body) {
      requestAnimationFrame(start);
      return;
    }
    syncWaClass();
    observer?.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'data-vscode-theme-kind'],
    });
  };
  start();
  // Also react to OS-level dark-mode changes when the host hasn't set a class.
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', syncWaClass);
}
