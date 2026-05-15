import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { repoPath } from '../desktop/desktopTestPaths.mjs';

function readSource(relativePath: string): string {
  return readFileSync(repoPath(relativePath), 'utf8');
}

describe('ProposalRequestPanel', () => {
  it('renders proposal instructions through the progress markdown renderer', () => {
    const source = readSource(
      'packages/extension/src/progressView/frontend/components/ProposalRequestPanel.ts',
    );

    expect(source).toContain('processMarkdownContent(instruction)');
    expect(source).toContain('unsafeHTML(markdownHtml)');
    expect(source).toContain('markdown-content');
  });
});
