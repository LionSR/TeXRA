// Third-party imports
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Subject under test - the host-neutral theme helpers shared between the
// VS Code webviews and the Electron renderer.
import { resolvePostMessageTargetOrigin } from '@shared/postMessageOrigin';
import { applyHostBodyTheme } from '@ui/wa/hostTheme';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
};

describe('applyHostBodyTheme', () => {
  beforeEach(() => {
    const dom = new JSDOM('<!doctype html><body></body>', {
      url: 'http://localhost/',
    });
    globalThis.window = dom.window as unknown as Window & typeof globalThis;
    globalThis.document = dom.window.document;
  });
  afterEach(() => {
    globalThis.document = originalGlobals.document;
    globalThis.window = originalGlobals.window;
  });

  it('replaces stale vscode-* body classes', () => {
    const body = globalThis.document.body;
    body.classList.add('vscode-light', 'unrelated-class');
    applyHostBodyTheme('dark');
    expect(body.classList.contains('vscode-dark')).toBe(true);
    expect(body.classList.contains('vscode-light')).toBe(false);
    // Caller-set classes that aren't theme-related must not be touched.
    expect(body.classList.contains('unrelated-class')).toBe(true);
    expect(body.dataset.vscodeThemeKind).toBe('dark');
  });
});

describe('resolvePostMessageTargetOrigin', () => {
  it('falls back to "*" when origin is the literal string "null" (file://)', () => {
    // Chromium returns the literal string "null" for file:// URLs. The helper
    // must not pass that through to window.postMessage or messages get
    // silently dropped.
    expect(resolvePostMessageTargetOrigin('null')).toBe('*');
  });

  it('falls back to "*" when origin is undefined', () => {
    expect(resolvePostMessageTargetOrigin(undefined)).toBe('*');
  });
});
