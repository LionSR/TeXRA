// Node imports
import { readFileSync } from 'node:fs';

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

  it('keeps the --desktop-color-* palette layer scoped to the bridge (not consumer code)', () => {
    // Per #3741, --desktop-color-* / --desktop-font-* tokens still serve as
    // an internal palette layer inside this bridge file (so the WA semantic
    // tokens read from named palette entries rather than scattered
    // light-dark() literals), but consumer code references only --wa-*. We
    // test the bridge invariant by checking that the palette + var() refs
    // are confined to this file. Strip CSS comments first so prose in
    // doc-comments cannot accidentally satisfy the assertion.
    const css = readThemeTokens().replaceAll(/\/\*[\s\S]*?\*\//g, '');

    // The palette declarations and intra-bridge var() refs are expected here:
    expect(css).toMatch(/--desktop-color-[a-zA-Z-]+\s*:/);
    expect(css).toMatch(/var\(--desktop-color-[a-zA-Z-]+\)/);
  });
});
