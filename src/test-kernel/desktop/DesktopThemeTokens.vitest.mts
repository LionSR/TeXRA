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
  it('exports textarea and text input colors through the WA form-control bridge', () => {
    const document = createThemeDocument(`
      textarea,
      input[type='text'] {
        background: var(--vscode-textArea-background);
        border-color: var(--vscode-textArea-border);
        color: var(--vscode-textArea-foreground);
      }
    `);
    const rootStyle = document.defaultView!.getComputedStyle(
      document.documentElement,
    );

    expect(
      rootStyle.getPropertyValue('--vscode-textArea-background').trim(),
    ).toBe('var(--wa-form-control-background-color)');
    expect(rootStyle.getPropertyValue('--vscode-textArea-border').trim()).toBe(
      'var(--wa-form-control-border-color)',
    );
    expect(
      rootStyle.getPropertyValue('--vscode-textArea-foreground').trim(),
    ).toBe('var(--wa-form-control-text-color)');
    expect(
      rootStyle
        .getPropertyValue('--vscode-settings-textInputBackground')
        .trim(),
    ).toBe('var(--wa-form-control-background-color)');
    expect(rootStyle.getPropertyValue('--texra-input-background').trim()).toBe(
      'var(--wa-form-control-background-color)',
    );
    expect(
      rootStyle.getPropertyValue('--wa-form-control-background-color').trim(),
    ).toMatch(/^light-dark\(#ffffff,\s*#313131\)$/);
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

  it('does not retain --desktop-color-* / --desktop-font-* indirection (palette lives on --wa-* directly)', () => {
    // Strip CSS comments so wording in doc-comments cannot accidentally satisfy
    // the assertion. We only care about real declarations and var() refs.
    const css = readThemeTokens().replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/--desktop-color-[a-zA-Z-]+\s*:/);
    expect(css).not.toMatch(/--desktop-font-[a-zA-Z-]+\s*:/);
    expect(css).not.toMatch(/var\(--desktop-color-[a-zA-Z-]+\)/);
    expect(css).not.toMatch(/var\(--desktop-font-[a-zA-Z-]+\)/);
  });
});
