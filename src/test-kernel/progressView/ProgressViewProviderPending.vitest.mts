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
  it('does not type its local logger as agent trace internals', () => {
    const source = readProgressViewProvider();

    expect(source).not.toContain("from '@agent/trace'");
    expect(source).toContain('interface ProgressViewLogger');
    expect(source).toContain('private readonly logger: ProgressViewLogger');
  });

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
