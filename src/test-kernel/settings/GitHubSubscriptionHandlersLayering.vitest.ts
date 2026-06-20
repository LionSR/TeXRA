import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);

function readGitHubSubscriptionHandlers(): string {
  return readFileSync(
    resolve(
      REPO_ROOT,
      'packages/extension/src/settingsView/handlers/githubSubscriptionHandlers.ts',
    ),
    'utf8',
  );
}

function importSources(source: string): string[] {
  return [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
    (match) => match[1] ?? '',
  );
}

describe('GitHubSubscriptionHandlers layering', () => {
  it('uses the progress navigation facade instead of progress view state', () => {
    const imports = importSources(readGitHubSubscriptionHandlers());

    expect(imports).not.toContain('@progressView/ProgressViewProvider');
    expect(imports).not.toContain(
      '@shared/progressView/backend/streamInfoUtils',
    );
    expect(imports).toContain('@progressView/progressNavigation');
  });
});
