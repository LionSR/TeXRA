// Node imports
import { strict as assert } from 'node:assert';
import * as path from 'node:path';

// Third-party imports
import { describe, it, beforeEach, afterEach, vi } from 'vitest';

// Local imports
import { maybeSaveDebugObject } from '@agent/utils/debugMessageSaver';
import { RUNS_STORAGE_DIR } from '@platform/defaults/workspaceStorage';
import type { ExecutionId } from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import { WorkspaceFS, StorageFS } from '@utils/files';

// getConfig reads through the platform config provider; enable the
// debug-object saving flag there instead of patching the ESM export.
setupPlatform({
  config: { 'texra.debug.saveDebugObjects': true },
});

describe('maybeSaveDebugObject', () => {
  let storageWrites: { relativePath: string; value: unknown }[];
  let ensured: string[];
  let workspaceWrites: { relativePath: string; value: unknown }[];
  let infoLogs: string[];
  let errorLogs: string[];

  beforeEach(() => {
    storageWrites = [];
    ensured = [];
    workspaceWrites = [];
    infoLogs = [];
    errorLogs = [];

    vi.spyOn(StorageFS, 'writeJson').mockImplementation(
      async (relativePath, value) => {
        storageWrites.push({ relativePath, value });
      },
    );

    vi.spyOn(StorageFS, 'ensureDir').mockImplementation(
      async (relativePath) => {
        ensured.push(relativePath);
      },
    );

    vi.spyOn(StorageFS, 'fullPath').mockImplementation((relativePath) =>
      path.join('/mock/storage', relativePath),
    );

    vi.spyOn(WorkspaceFS, 'writeJson').mockImplementation(
      async (relativePath, value) => {
        workspaceWrites.push({ relativePath, value });
      },
    );

    vi.spyOn(WorkspaceFS, 'fullPath').mockImplementation((relativePath) =>
      path.join('/mock/workspace', relativePath),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates the run directory and writes debug objects under storage when executionId is provided', async () => {
    const executionId = 'run-42' as ExecutionId;

    const logger = {
      info: (message: string) => {
        infoLogs.push(message);
      },
      error: (message: string) => {
        errorLogs.push(message);
      },
    } as unknown as import('@agent/trace').AgentTrace;

    await maybeSaveDebugObject({
      object: { foo: 'bar' },
      objectType: 'response',
      context: {
        logger,
        executionId,
      },
    });

    const expectedDir = path.join(RUNS_STORAGE_DIR, executionId);
    assert.deepEqual(ensured, [RUNS_STORAGE_DIR, expectedDir]);

    assert.equal(storageWrites.length, 1);
    const expectedRelativePath = path.join(expectedDir, 'response.json');
    assert.equal(storageWrites[0].relativePath, expectedRelativePath);
    assert.equal(workspaceWrites.length, 0);

    assert.equal(infoLogs.length, 1);
    assert.equal(errorLogs.length, 0);
    assert.equal(
      infoLogs[0],
      `Saved response object to ${path.join(
        '/mock/storage',
        expectedRelativePath,
      )}`,
    );
  });
});
