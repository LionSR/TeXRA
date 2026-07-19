// Third-party imports
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'vitest';

// Standard library imports

// Local imports - agent
// Internal imports
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
  type StorageFsMutable = {
    writeJson: typeof StorageFS.writeJson;
    ensureDir: typeof StorageFS.ensureDir;
    fullPath: typeof StorageFS.fullPath;
  };

  type WorkspaceFsMutable = {
    writeJson: typeof WorkspaceFS.writeJson;
    fullPath: typeof WorkspaceFS.fullPath;
  };

  const storageFs = StorageFS as unknown as StorageFsMutable;
  const workspaceFs = WorkspaceFS as unknown as WorkspaceFsMutable;

  const originalStorageWriteJson = storageFs.writeJson;
  const originalStorageEnsureDir = storageFs.ensureDir;
  const originalStorageFullPath = storageFs.fullPath;
  const originalWorkspaceWriteJson = workspaceFs.writeJson;
  const originalWorkspaceFullPath = workspaceFs.fullPath;

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

    storageFs.writeJson = async (relativePath, value) => {
      storageWrites.push({ relativePath, value });
    };

    storageFs.ensureDir = async (relativePath) => {
      ensured.push(relativePath);
    };

    storageFs.fullPath = (relativePath) =>
      path.join('/mock/storage', relativePath);

    workspaceFs.writeJson = async (relativePath, value) => {
      workspaceWrites.push({ relativePath, value });
    };

    workspaceFs.fullPath = (relativePath) =>
      path.join('/mock/workspace', relativePath);
  });

  afterEach(() => {
    storageFs.writeJson = originalStorageWriteJson;
    storageFs.ensureDir = originalStorageEnsureDir;
    storageFs.fullPath = originalStorageFullPath;
    workspaceFs.writeJson = originalWorkspaceWriteJson;
    workspaceFs.fullPath = originalWorkspaceFullPath;
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
