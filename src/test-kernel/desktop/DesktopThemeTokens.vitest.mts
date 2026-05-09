// Node imports
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

// Third-party imports
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

// Local imports - desktop test paths
import { repoPath } from './desktopTestPaths.mjs';

function readThemeTokens(): string {
  return readFileSync(
    repoPath('packages/desktop/src/renderer/themeTokens.css'),
    'utf8',
  );
}

function createThemeDocument(extraCss = ''): Document {
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body></body></html>',
  );
  const style = dom.window.document.createElement('style');
  style.textContent = `${readThemeTokens()}\n${extraCss}`;
  dom.window.document.head.append(style);
  return dom.window.document;
}

describe('desktop theme tokens', () => {
  it('defines textarea and text input colors via the WA form-control tokens', () => {
    // Per #3741, consumer code references --wa-* tokens directly and the
    // --vscode-textArea-* / --vscode-settings-textInputBackground re-exports
    // were retired (the desktop renderer no longer ships those aliases).
    // The bridge contract is now: --wa-form-control-* are defined in the
    // theme and consumers read them directly.
    const document = createThemeDocument();
    const rootStyle = document.defaultView!.getComputedStyle(
      document.documentElement,
    );

    expect(
      rootStyle.getPropertyValue('--wa-form-control-background-color').trim(),
    ).toMatch(/^light-dark\(#ffffff,\s*#313131\)$/);
    expect(
      rootStyle.getPropertyValue('--wa-form-control-text-color').trim(),
    ).toMatch(/^light-dark\(#1f2328,\s*#cccccc\)$/);
    expect(
      rootStyle.getPropertyValue('--wa-form-control-border-color').trim(),
    ).toMatch(/^light-dark\(#d0d7de,\s*#3c3c3c\)$/);
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

  it('overrides --wa-border-radius-* tokens to VS Code-square values', () => {
    const document = createThemeDocument();
    const rootStyle = document.defaultView!.getComputedStyle(
      document.documentElement,
    );

    expect(rootStyle.getPropertyValue('--wa-border-radius-s').trim()).toBe(
      '2px',
    );
    expect(rootStyle.getPropertyValue('--wa-border-radius-m').trim()).toBe(
      '3px',
    );
    expect(rootStyle.getPropertyValue('--wa-border-radius-l').trim()).toBe(
      '4px',
    );
    expect(rootStyle.getPropertyValue('--wa-border-radius-pill').trim()).toBe(
      '9999px',
    );
    expect(rootStyle.getPropertyValue('--wa-border-radius-circle').trim()).toBe(
      '50%',
    );
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
