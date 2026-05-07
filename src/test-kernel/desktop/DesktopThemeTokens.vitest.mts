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
  it('exports textarea and text input colors through the VS Code token bridge', () => {
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
    ).toBe('var(--texra-input-background)');
    expect(rootStyle.getPropertyValue('--vscode-textArea-border').trim()).toBe(
      'var(--texra-input-border)',
    );
    expect(
      rootStyle.getPropertyValue('--vscode-textArea-foreground').trim(),
    ).toBe('var(--texra-input-foreground)');
    expect(
      rootStyle
        .getPropertyValue('--vscode-settings-textInputBackground')
        .trim(),
    ).toBe('var(--texra-input-background)');
    expect(rootStyle.getPropertyValue('--texra-input-background').trim()).toBe(
      'var(--desktop-color-input-background)',
    );
    expect(
      rootStyle.getPropertyValue('--desktop-color-input-background').trim(),
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
});
