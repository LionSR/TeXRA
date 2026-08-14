import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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
    expect(
      ensureDir.mock.calls.map(([relativePath]) => relativePath),
    ).toEqual([RUNS_STORAGE_DIR, expectedDir]);

    const expectedRelativePath = resolveRunStoragePath(
      'run-42' as ExecutionId,
      'response.json',
    );
    expect(writeStorage.mock.calls.length).toBe(1);
    expect(writeStorage.mock.calls[0]?.[0]).toBe(expectedRelativePath);
    expect(writeWorkspace.mock.calls.length).toBe(0);

    expect(info.mock.calls.length).toBe(1);
    expect(error.mock.calls.length).toBe(0);
    expect(info.mock.calls[0]?.[0]).toBe(
      `Saved response object to ${path.join(
        '/mock/storage',
        expectedRelativePath,
      )}`,
    );
  });
});
