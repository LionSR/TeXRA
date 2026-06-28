import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);

function readSource(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

function importSources(source: string): string[] {
  return [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
    (match) => match[1] ?? '',
  );
}

describe('progress view layering', () => {
  it('keeps stream-info derivation behind the progress provider boundary', () => {
    const helperFiles = [
      'packages/extension/src/progressView/progressNavigation.ts',
      'packages/extension/src/progressView/managers/ProgressStreamLifecycleHost.ts',
    ];

    for (const file of helperFiles) {
      expect(importSources(readSource(file))).not.toContain(
        '@shared/progressView/backend/streamInfoUtils',
      );
    }
  });

  it('keeps goal-state projection out of the progress message dispatcher', () => {
    expect(
      importSources(
        readSource(
          'packages/extension/src/progressView/ProgressViewMessageHandler.ts',
        ),
      ),
    ).not.toContain('@agent/runtime/goalCommands');
  });

  it('keeps agent-category projection out of the progress message dispatcher', () => {
    expect(
      importSources(
        readSource(
          'packages/extension/src/progressView/ProgressViewMessageHandler.ts',
        ),
      ),
    ).not.toContain('@agent/runtime/agentResolution');
  });
});
