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
    const source = readProgressViewProvider();
    const methodStart = source.indexOf('hasPendingPermissionsForStream');
    const methodEnd = source.indexOf('private canSendToWebview', methodStart);
    expect(methodStart).toBeGreaterThanOrEqual(0);
    expect(methodEnd).toBeGreaterThan(methodStart);
    const method = source.slice(methodStart, methodEnd);

    expect(method).toContain(
      'this.userQuestionHandler.hasPendingForStream(streamId)',
    );
  });
});
