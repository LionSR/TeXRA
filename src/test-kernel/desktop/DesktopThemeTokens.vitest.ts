// Node imports
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

// Third-party imports
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

// Local imports - desktop test paths
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
    const rootStyle = readRootStyle();
    // Assembled rather than written literally: this file lives under src/, and
    // the confinement test below forbids any consumer source from naming a
    // palette token outright.
    const paletteRef = (entry: string): string =>
      `var(${['--desktop', 'color', entry].join('-')})`;

    expect(
      rootStyle.getPropertyValue('--wa-form-control-background-color').trim(),
    ).toBe(paletteRef('input-background'));
    expect(
      rootStyle.getPropertyValue('--wa-form-control-text-color').trim(),
    ).toBe(paletteRef('input-foreground'));
    expect(
      rootStyle.getPropertyValue('--wa-form-control-border-color').trim(),
    ).toBe(paletteRef('input-border'));
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
    const rootStyle = readRootStyle();
    const compact = (name: string): string =>
      rootStyle.getPropertyValue(name).trim().replaceAll(/\s+/g, ' ');
    const paletteName = (entry: string): string =>
      ['--desktop', 'color', entry].join('-');

    expect(compact(paletteName('background'))).toBe(
      'light-dark(#ffffff,#212121)',
    );
    expect(compact(paletteName('accent'))).toBe('light-dark(#0d0d0d,#f4f4f4)');
    expect(compact('--wa-color-brand-on-loud')).toBe(
      'light-dark(#ffffff,#0d0d0d)',
    );
    expect(css).not.toContain('radial-gradient(');
    expect(compact(paletteName('info'))).not.toBe(
      compact(paletteName('accent')),
    );
  });

  it('defines one focus and reduced-motion contract', () => {
    const css = readThemeTokens();
    const rootStyle = readRootStyle();

    expect(rootStyle.getPropertyValue('--wa-focus-ring-width').trim()).toBe(
      '2px',
    );
    expect(rootStyle.getPropertyValue('--wa-focus-ring-offset').trim()).toBe(
      '2px',
    );
    expect(rootStyle.getPropertyValue('--wa-transition-normal').trim()).toBe(
      '160ms',
    );
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
        `body\\.vscode-high-contrast[\\s\\S]*${[
          '--desktop',
          'color',
          'focus',
        ].join('-')}:\\s*Highlight`,
      ),
    );
  });

  it('ships a rounded, ascending --wa-border-radius-* scale', () => {
    // These were pinned to 2/3/4px so controls would pass for native VS Code
    // chrome. The desktop app is a standalone product with a softer shape
    // language, so the contract is now structural: the scale ascends, and no
    // step is small enough to read as a hard rectangle. Exact values stay a
    // design choice.
    const rootStyle = readRootStyle();
    const px = (name: string): number =>
      Number.parseFloat(rootStyle.getPropertyValue(name).trim());

    const s = px('--wa-border-radius-s');
    const m = px('--wa-border-radius-m');
    const l = px('--wa-border-radius-l');
    const xl = px('--wa-border-radius-xl');

    expect(s).toBeGreaterThanOrEqual(4);
    expect(m).toBeGreaterThan(s);
    expect(l).toBeGreaterThan(m);
    expect(xl).toBeGreaterThan(l);
    expect(rootStyle.getPropertyValue('--wa-border-radius-pill').trim()).toBe(
      '9999px',
    );
    expect(rootStyle.getPropertyValue('--wa-border-radius-circle').trim()).toBe(
      '50%',
    );
  });

  it('sizes shared Lit controls for a window rather than a sidebar', () => {
    // litStyles.ts reads these with the extension's compact values as
    // fallbacks, so the desktop host must actually supply the roomier metrics
    // or the shared components silently stay at editor-panel density.
    const rootStyle = readRootStyle();
    const px = (name: string): number =>
      Number.parseFloat(rootStyle.getPropertyValue(name).trim());

    expect(px('--wa-height-control')).toBeGreaterThan(24);
    expect(px('--wa-height-header')).toBeGreaterThan(34);
    expect(px('--wa-height-button')).toBeGreaterThan(30);
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
    const insideCss = readThemeTokens().replaceAll(/\/\*[\s\S]*?\*\//g, '');
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
  const stripCommentsCss = (text: string): string =>
    text.replaceAll(/\/\*[\s\S]*?\*\//g, '');
  const stripCommentsTs = (text: string): string =>
    text
      .replaceAll(/\/\*[\s\S]*?\*\//g, '')
      .replaceAll(/(^|[^:])\/\/.*$/gm, '$1');

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
        ? stripCommentsCss(raw)
        : stripCommentsTs(raw);
      if (tokenPattern.test(text)) {
        offenders.push(relative(repoRoot, absPath));
      }
    });
  }
  return offenders;
}

function walk(dir: string, visit: (absPath: string) => void): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
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
