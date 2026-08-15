import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

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

// Assembled rather than written literally: this file lives under src/, and
// the confinement test below forbids any consumer source from naming a
// palette token outright.
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

/** Strip CSS block comments so prose references can't satisfy token matches. */
function stripCssComments(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//g, '');
}

describe('desktop theme tokens', () => {
  it('defines textarea and text input colors via the WA form-control tokens', () => {
    // Per #3741, consumer code references --wa-* tokens directly and the
    // --vscode-textArea-* / --vscode-settings-textInputBackground re-exports
    // were retired (the desktop renderer no longer ships those aliases).
    // The bridge contract is now: --wa-form-control-* are defined in the
    // theme and consumers read them directly.
    //
    // These used to be asserted as literal VS Code hex pairs. They now resolve
    // through the --desktop-color-input-* palette entries so the input skin
    // changes in one place — assert the indirection, not the color values,
    // which are a design choice and free to change.
    expect(tokenValue('--wa-form-control-background-color')).toBe(
      `var(${paletteToken('input-background')})`,
    );
    expect(tokenValue('--wa-form-control-text-color')).toBe(
      `var(${paletteToken('input-foreground')})`,
    );
    expect(tokenValue('--wa-form-control-border-color')).toBe(
      `var(${paletteToken('input-border')})`,
    );
  });

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

  it('keeps light and dark palettes in one semantic token layer', () => {
    const css = readThemeTokens();
    const darkBlock = css.match(
      /body\.vscode-dark,\s*body\.texra-dark\s*{(?<body>[^}]*)}/,
    )?.groups?.body;

    expect(css).toContain('light-dark(');
    expect(darkBlock).toContain('color-scheme: dark;');
    expect(darkBlock).not.toContain('--texra-input-background');
    expect(darkBlock).not.toContain('--vscode-textArea-background');
  });

  it('uses neutral surfaces and achromatic primary actions', () => {
    const css = readThemeTokens();
    const compact = (name: string): string =>
      tokenValue(name).replaceAll(/\s+/g, ' ');

    expect(compact(paletteToken('background'))).toBe(
      'light-dark(#ffffff,#212121)',
    );
    expect(compact(paletteToken('accent'))).toBe('light-dark(#0d0d0d,#f4f4f4)');
    expect(compact('--wa-color-brand-on-loud')).toBe(
      'light-dark(#ffffff,#0d0d0d)',
    );
    expect(css).not.toContain('radial-gradient(');
    expect(compact(paletteToken('info'))).not.toBe(
      compact(paletteToken('accent')),
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

  it('ships a rounded, ascending --wa-border-radius-* scale', () => {
    // These were pinned to 2/3/4px so controls would pass for native VS Code
    // chrome. The desktop app is a standalone product with a softer shape
    // language, so the contract is now structural: the scale ascends, and no
    // step is small enough to read as a hard rectangle. Exact values stay a
    // design choice.
    const s = tokenPx('--wa-border-radius-s');
    const m = tokenPx('--wa-border-radius-m');
    const l = tokenPx('--wa-border-radius-l');
    const xl = tokenPx('--wa-border-radius-xl');

    expect(s).toBeGreaterThanOrEqual(4);
    expect(m).toBeGreaterThan(s);
    expect(l).toBeGreaterThan(m);
    expect(xl).toBeGreaterThan(l);
    expect(tokenValue('--wa-border-radius-pill')).toBe('9999px');
    expect(tokenValue('--wa-border-radius-circle')).toBe('50%');
  });

  it('sizes shared Lit controls for a window rather than a sidebar', () => {
    // litStyles.ts reads these with the extension's compact values as
    // fallbacks, so the desktop host must actually supply the roomier metrics
    // or the shared components silently stay at editor-panel density.
    expect(tokenPx('--wa-height-control')).toBeGreaterThan(24);
    expect(tokenPx('--wa-height-header')).toBeGreaterThan(34);
    expect(tokenPx('--wa-height-button')).toBeGreaterThan(30);
  });

  it('keeps the --desktop-color-* palette layer confined to themeTokens.css (no consumer references)', () => {
    // Per #3741, --desktop-color-* / --desktop-font-* tokens serve as an
    // internal palette layer inside the bridge file (so the WA semantic
    // tokens read from named palette entries rather than scattered
    // light-dark() literals), but consumer code references only --wa-*.
    // Verify both halves:
    //   (a) themeTokens.css declares the palette and uses it via var().
    //   (b) no consumer source under packages/desktop, packages/extension,
    //       or src/ references --desktop-color-* or --desktop-font-*.
    // Strip CSS comments before matching so prose in doc-comments cannot
    // accidentally satisfy the inside-file expectations.
    const insideCss = stripCssComments(readThemeTokens());
    expect(insideCss).toMatch(/--desktop-color-[a-zA-Z-]+\s*:/);
    expect(insideCss).toMatch(/var\(--desktop-color-[a-zA-Z-]+\)/);

    const consumerOffenders = collectDesktopTokenOffenders();
    expect(consumerOffenders).toEqual([]);
  });
});

/**
 * Walk consumer source trees and collect any file (other than the bridge
 * itself) that references --desktop-color-* or --desktop-font-*. The bridge
 * file is the single place those tokens are allowed.
 */
function collectDesktopTokenOffenders(): string[] {
  const repoRoot = repoPath('.');
  const bridgeAbs = repoPath('packages/desktop/src/renderer/themeTokens.css');
  const offenders: string[] = [];
  const tokenPattern = /--desktop-(color|font)-[a-zA-Z-]+/;
  // CSS comments + multi-line JS/TS comments. The regex pass ignores
  // declarations/refs that live inside any comment so doc-comments referencing
  // these tokens don't trip the test.
  const stripCommentsTs = (text: string): string =>
    stripCssComments(text).replaceAll(/(^|[^:])\/\/.*$/gm, '$1');

  for (const dir of [
    repoPath('packages/desktop/src'),
    repoPath('packages/extension/src'),
    repoPath('src'),
  ]) {
    walk(dir, (absPath) => {
      if (absPath === bridgeAbs) return;
      if (!/\.(css|ts|mts|tsx|js|mjs|cjs)$/.test(absPath)) return;
      const raw = readFileSync(absPath, 'utf8');
      const text = absPath.endsWith('.css')
        ? stripCssComments(raw)
        : stripCommentsTs(raw);
      if (tokenPattern.test(text)) {
        offenders.push(relative(repoRoot, absPath));
      }
    });
  }
  return offenders;
}

function walk(dir: string, visit: (absPath: string) => void): void {
  // Let readdirSync throw: swallowing it would silently shrink the scanned
  // tree and let the confinement test pass vacuously.
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, visit);
    } else if (entry.isFile()) {
      visit(full);
    }
  }
}
