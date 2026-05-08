// Third-party imports
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Subject under test - the host-neutral theme helpers shared between the
// VS Code BaseWebviewApp and the Electron renderer.
import {
  applyHostBodyTheme,
  getWindowTargetOrigin,
  themeIsDark,
} from '@shared/wa/hostTheme';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
};

function installDom(url: string): JSDOM {
  const dom = new JSDOM('<!doctype html><body></body>', { url });
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  return dom;
}

function restoreDom(): void {
  globalThis.document = originalGlobals.document;
  globalThis.window = originalGlobals.window;
}

describe('themeIsDark', () => {
  it('treats dark and high-contrast as dark', () => {
    expect(themeIsDark('dark')).toBe(true);
    expect(themeIsDark('high-contrast')).toBe(true);
    expect(themeIsDark('light')).toBe(false);
  });
});

describe('applyHostBodyTheme', () => {
  beforeEach(() => {
    installDom('http://localhost/');
  });
  afterEach(() => {
    restoreDom();
  });

  it('replaces stale vscode-* / texra-* body classes', () => {
    const body = globalThis.document.body;
    body.classList.add('vscode-light', 'texra-light', 'unrelated-class');
    applyHostBodyTheme('dark');
    expect(body.classList.contains('vscode-dark')).toBe(true);
    expect(body.classList.contains('texra-dark')).toBe(true);
    expect(body.classList.contains('vscode-light')).toBe(false);
    expect(body.classList.contains('texra-light')).toBe(false);
    // Caller-set classes that aren't theme-related must not be touched.
    expect(body.classList.contains('unrelated-class')).toBe(true);
    expect(body.dataset.vscodeThemeKind).toBe('dark');
  });

  it('toggles wa-light/wa-dark on <html> via the shared helper', () => {
    const root = globalThis.document.documentElement;
    applyHostBodyTheme('light');
    expect(root.classList.contains('wa-light')).toBe(true);
    expect(root.classList.contains('wa-dark')).toBe(false);
    applyHostBodyTheme('dark');
    expect(root.classList.contains('wa-dark')).toBe(true);
    expect(root.classList.contains('wa-light')).toBe(false);
    applyHostBodyTheme('high-contrast');
    // High-contrast resolves to dark (matches desktop theme tokens).
    expect(root.classList.contains('wa-dark')).toBe(true);
  });
});

describe('getWindowTargetOrigin', () => {
  afterEach(() => {
    restoreDom();
  });

  it('returns the origin when loaded over http(s)://', () => {
    installDom('http://localhost:5173/');
    expect(getWindowTargetOrigin()).toBe('http://localhost:5173');
  });

  it('falls back to "*" when loaded over file:// (origin === "null")', () => {
    installDom('file:///path/to/index.html');
    // JSDOM returns the literal string "null" for file:// URLs, matching
    // Chromium's behaviour. The helper must not pass that through to
    // window.postMessage or messages get silently dropped.
    expect(getWindowTargetOrigin()).toBe('*');
  });
});
