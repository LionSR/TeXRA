// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);

function readToolUseStyles(): string {
  return readFileSync(
    resolve(
      REPO_ROOT,
      'packages/extension/src/progressView/frontend/styles/toolUseStyles.ts',
    ),
    'utf8',
  );
}

describe('tool-use progress styles', () => {
  it('wraps long tool summary titles instead of truncating command lines', () => {
    const source = readToolUseStyles();
    const titleRule = source.match(/\.tool-use-title\s*\{[^}]+\}/)?.[0] ?? '';

    expect(titleRule).toContain('white-space: normal');
    expect(titleRule).toContain('overflow-wrap: anywhere');
    expect(titleRule).not.toContain('white-space: nowrap');
    expect(titleRule).not.toContain('text-overflow: ellipsis');
  });
});
