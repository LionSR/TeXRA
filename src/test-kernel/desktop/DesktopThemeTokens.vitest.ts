import { readFileSync } from 'node:fs';

import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';

import { repoPath } from './desktopTestPaths.ts';

function readThemeTokens(): string {
  return readFileSync(
    repoPath('packages/desktop/src/renderer/themeTokens.css'),
    'utf8',
  );
}

function readRootStyle(): CSSStyleDeclaration {
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body></body></html>',
  );
  const style = dom.window.document.createElement('style');
  style.textContent = readThemeTokens();
  dom.window.document.head.append(style);
  return dom.window.document.defaultView!.getComputedStyle(
    dom.window.document.documentElement,
  );
}

function paletteToken(entry: string): string {
  return ['--desktop', 'color', entry].join('-');
}

let rootStyle: CSSStyleDeclaration;

beforeAll(() => {
  rootStyle = readRootStyle();
});

function tokenValue(name: string): string {
  return rootStyle.getPropertyValue(name).trim();
}

function tokenPx(name: string): number {
  return Number.parseFloat(tokenValue(name));
}

describe('desktop theme tokens', () => {
  it('pairs the terminal foreground and cursor with the terminal background', () => {
    // In the high-contrast themes the background/foreground palette entries
    // resolve to the Canvas/CanvasText system pair while the input entries
    // resolve to Field/FieldText, and users can configure those pairs
    // independently — an input-sourced terminal foreground can be unreadable
    // on the terminal background. Assert the indirection, not the color
    // values, which are a design choice and free to change.
    expect(tokenValue('--wa-color-terminal-background')).toBe(
      `var(${paletteToken('background')})`,
    );
    expect(tokenValue('--wa-color-terminal-foreground')).toBe(
      `var(${paletteToken('foreground')})`,
    );
    expect(tokenValue('--wa-color-terminal-cursor')).toBe(
      `var(${paletteToken('foreground')})`,
    );
  });

  it('defines one focus and reduced-motion contract', () => {
    const css = readThemeTokens();

    expect(tokenValue('--wa-focus-ring-width')).toBe('2px');
    expect(tokenValue('--wa-focus-ring-offset')).toBe('2px');
    expect(tokenValue('--wa-transition-normal')).toBe('160ms');
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*--wa-transition-normal:\s*0ms/,
    );
    // The custom-shell durations are damped by the same block. These are the
    // shared `--transition-*` names the bridge overrides — the desktop's former
    // parallel `--desktop-transition-*` ramp was retired, so damping only the
    // WA names would leave every hand-written transition animating.
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*--transition-normal:\s*0ms/,
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*--transition-fast:\s*0ms/,
    );
    expect(css).toMatch(
      new RegExp(
        `body\\.vscode-high-contrast[\\s\\S]*${paletteToken('focus')}:\\s*Highlight`,
      ),
    );
  });

  it('sizes shared Lit controls for a window rather than a sidebar', () => {
    // litStyles.ts reads these with the extension's compact values as
    // fallbacks, so the desktop host must actually supply the roomier metrics
    // or the shared components silently stay at editor-panel density.
    expect(tokenPx('--wa-height-control')).toBeGreaterThan(24);
    expect(tokenPx('--wa-height-header')).toBeGreaterThan(34);
    expect(tokenPx('--wa-height-button')).toBeGreaterThan(30);
  });
});
