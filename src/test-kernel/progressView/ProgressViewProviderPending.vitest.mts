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

function readProgressViewProvider(): string {
  return readFileSync(
    resolve(
      REPO_ROOT,
      'packages/extension/src/progressView/ProgressViewProvider.ts',
    ),
    'utf8',
  );
}

describe('ProgressViewProvider pending permissions', () => {
  it('keeps streams with pending user questions active', () => {
    // The pending-permission gate now lives in the shared backend UI config so
    // every host computes it the same way.
    const source = readFileSync(
      resolve(
        REPO_ROOT,
        'src/shared/progressView/backend/progressBackendUiConfig.ts',
      ),
      'utf8',
    );
    const methodStart = source.indexOf('hasPendingPermissions');
    expect(methodStart).toBeGreaterThanOrEqual(0);

    expect(source).toContain(
      'handlers.userQuestion.hasPendingForStream(streamId)',
    );
  });

  it('keeps proposal agent dropdown identity separate from display labels', () => {
    const source = readProgressViewProvider();
    const methodStart = source.indexOf('sendProposalModelOptions');
    const methodEnd = source.indexOf('public static getInstance', methodStart);
    expect(methodStart).toBeGreaterThanOrEqual(0);
    expect(methodEnd).toBeGreaterThan(methodStart);
    const method = source.slice(methodStart, methodEnd);

    expect(method).toContain('value: agentName(opt.value)');
    expect(method).not.toContain('value: opt.label');
  });
});
