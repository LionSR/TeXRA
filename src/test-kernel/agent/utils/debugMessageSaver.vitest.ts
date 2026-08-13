import { strict as assert } from 'node:assert';
import * as path from 'node:path';

import { describe, it, afterEach, vi } from 'vitest';

import type { AgentTrace } from '@agent/trace';
import { maybeSaveDebugObject } from '@agent/utils/debugMessageSaver';
import {
  resolveRunStoragePath,
  RUNS_STORAGE_DIR,
} from '@platform/defaults/workspaceStorage';
import type { ExecutionId } from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import { StorageFS } from '@utils/files/storageFS';
import { WorkspaceFS } from '@utils/files/workspaceFS';

// getConfig reads through the platform config provider; enable the
// debug-object saving flag there instead of patching the ESM export.
setupPlatform({
  config: { 'texra.debug.saveModelIO': true },
});

describe('maybeSaveDebugObject', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates the run directory and writes debug objects under storage when executionId is provided', async () => {
    const writeStorage = vi
      .spyOn(StorageFS, 'write')
      .mockResolvedValue(undefined);
    const ensureDir = vi
      .spyOn(StorageFS, 'ensureDir')
      .mockResolvedValue(undefined);
    vi.spyOn(StorageFS, 'fullPath').mockImplementation((relativePath) =>
      path.join('/mock/storage', relativePath),
    );
    const writeWorkspace = vi
      .spyOn(WorkspaceFS, 'write')
      .mockResolvedValue(undefined);
    const info = vi.fn();
    const error = vi.fn();
    const logger = { info, error } as unknown as AgentTrace;

    await maybeSaveDebugObject({
      object: { foo: 'bar' },
      objectType: 'response',
      context: {
        logger,
        executionId: 'run-42' as ExecutionId,
      },
    });

    const expectedDir = resolveRunStoragePath('run-42' as ExecutionId);
    assert.deepEqual(
      ensureDir.mock.calls.map(([relativePath]) => relativePath),
      [RUNS_STORAGE_DIR, expectedDir],
    );

    const expectedRelativePath = resolveRunStoragePath(
      'run-42' as ExecutionId,
      'response.json',
    );
    assert.equal(writeStorage.mock.calls.length, 1);
    assert.equal(writeStorage.mock.calls[0]?.[0], expectedRelativePath);
    assert.equal(writeWorkspace.mock.calls.length, 0);

    assert.equal(info.mock.calls.length, 1);
    assert.equal(error.mock.calls.length, 0);
    assert.equal(
      info.mock.calls[0]?.[0],
      `Saved response object to ${path.join(
        '/mock/storage',
        expectedRelativePath,
      )}`,
    );
  });
});
