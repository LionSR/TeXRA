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
 */

let observer: MutationObserver | null = null;

function isDarkTheme(): boolean {
  const body = document.body;
  if (!body) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  if (
    body.classList.contains('vscode-dark') ||
    body.classList.contains('vscode-high-contrast') ||
    body.classList.contains('texra-dark') ||
    body.classList.contains('texra-high-contrast')
  ) {
    return true;
  }
  if (
    body.classList.contains('vscode-light') ||
    body.classList.contains('vscode-high-contrast-light') ||
    body.classList.contains('texra-light')
  ) {
    return false;
  }
  const kind = body.dataset.vscodeThemeKind;
  if (kind) {
    return kind === 'vscode-dark' || kind === 'vscode-high-contrast' || kind === 'dark' || kind === 'high-contrast';
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function syncWaClass(): void {
  const root = document.documentElement;
  const dark = isDarkTheme();
  // Only mutate when needed to avoid layout thrash when other observers run.
  if (dark && !root.classList.contains('wa-dark')) {
    root.classList.remove('wa-light');
    root.classList.add('wa-dark');
  } else if (!dark && !root.classList.contains('wa-light')) {
    root.classList.remove('wa-dark');
    root.classList.add('wa-light');
  }
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
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', syncWaClass);
    }
  }
}
