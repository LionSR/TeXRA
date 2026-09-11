// Node imports
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - test support
import { REPO_ROOT } from '@test/support/repoScan';

const COMMON_CSS = 'packages/extension/src/common/styles/common.css';

function readCommonCss(): string {
  return readFileSync(join(REPO_ROOT, COMMON_CSS), 'utf8');
}

/** Strip CSS block comments so prose references can't satisfy token matches. */
function stripCssComments(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Extract the --wa-color-terminal-background value with all whitespace
 * removed: formatting stays a style choice, while the variable chain and its
 * order are the pinned contract.
 */
function terminalBackgroundValue(css: string): string | undefined {
  return /--wa-color-terminal-background\s*:\s*(?<value>[^;]+);/
    .exec(stripCssComments(css))
    ?.groups?.value.replaceAll(/\s+/g, '');
}

describe('extension terminal CSS fallback chain', () => {
  it('keeps the panel-background fallback on the terminal background token', () => {
    // VS Code registers terminal.background without a default, so themes that
    // don't set it inject no --vscode-terminal-background into the webview;
    // the chain mirrors the integrated terminal by falling back to
    // --vscode-panel-background instead of silently dropping the token
    // (#10321). jsdom's custom-property var() substitution is too limited for
    // a computed-style assertion here, so pin the source text.
    expect(terminalBackgroundValue(readCommonCss())).toBe(
      'var(--vscode-terminal-background,var(--vscode-panel-background))',
    );
  });
});
