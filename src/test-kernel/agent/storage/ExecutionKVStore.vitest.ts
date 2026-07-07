import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setupPlatform } from '@test/support/setupPlatform';
import {
  clearStoreCache,
  EXECUTION_META_SCHEMA_VERSION,
  getExecutionStore,
} from '@agent/storage';
import * as logger from '@logger/logUtils';
import {
  EXECUTION_STATUS,
  RUN_OUTCOME,
  type ExecutionId,
  type RunOutcome,
} from '@shared/schemas';

setupPlatform({ workspacePath: '/workspace' });

beforeEach(() => {
  clearStoreCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExecutionKVStore meta read shims', () => {
  it.each([
    [EXECUTION_STATUS.COMPLETED, RUN_OUTCOME.COMPLETED],
    [EXECUTION_STATUS.INTERRUPTED, RUN_OUTCOME.CANCELLED],
    [EXECUTION_STATUS.ERROR, RUN_OUTCOME.FAILED],
  ] as const)(
    'maps legacy terminalStatus %s to outcome %s',
    async (terminalStatus, outcome) => {
      const id = `legacy-${terminalStatus}` as ExecutionId;
      await getExecutionStore(id).write('meta', {
        timestamp: '2026-07-04T00:00:00.000Z',
        terminalStatus,
      });

      await expect(getExecutionStore(id).readMeta()).resolves.toMatchObject({
        schemaVersion: EXECUTION_META_SCHEMA_VERSION,
        terminalStatus,
        outcome,
      });
    },
  );

  it.each(Object.values(RUN_OUTCOME) as RunOutcome[])(
    'preserves canonical outcome %s',
    async (outcome) => {
      const id = `canonical-${outcome}` as ExecutionId;
      await getExecutionStore(id).write('meta', {
        timestamp: '2026-07-04T00:00:00.000Z',
        outcome,
      });

      await expect(getExecutionStore(id).readMeta()).resolves.toMatchObject({
        schemaVersion: EXECUTION_META_SCHEMA_VERSION,
        outcome,
      });
    },
  );

  it('writes the current schema version for execution meta', async () => {
    const id = 'versioned-meta' as ExecutionId;

    await getExecutionStore(id).writeMeta({
      timestamp: '2026-07-04T00:00:00.000Z',
    });

    await expect(getExecutionStore(id).read('meta')).resolves.toMatchObject({
      schemaVersion: EXECUTION_META_SCHEMA_VERSION,
      timestamp: '2026-07-04T00:00:00.000Z',
    });
  });

  it('warns when execution meta is malformed instead of silently dropping it', async () => {
    const id = 'bad-meta' as ExecutionId;
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await getExecutionStore(id).write('meta', { timestamp: 123 });

    await expect(getExecutionStore(id).readMeta()).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      'ExecutionKVStore',
      expect.stringContaining(`Failed to parse execution ${id} meta.json`),
      { data: expect.any(Error) },
    );
  });
});

describe('ExecutionKVStore loud typed reads (#6966 bullet 5)', () => {
  it('warns when config is malformed instead of silently returning null', async () => {
    const id = 'bad-config' as ExecutionId;
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await getExecutionStore(id).write('config', { outputFiles: 'not-a-list' });

    await expect(getExecutionStore(id).readConfig()).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      'ExecutionKVStore',
      expect.stringContaining(`Failed to parse execution ${id} config.json`),
      { data: expect.any(Error) },
    );
  });

  it('warns when todos are malformed instead of silently defaulting to []', async () => {
    const id = 'bad-todos' as ExecutionId;
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await getExecutionStore(id).write('todos', { not: 'an array' });

    await expect(getExecutionStore(id).readTodos()).resolves.toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      'ExecutionKVStore',
      expect.stringContaining(`Failed to parse execution ${id} todos.json`),
      { data: expect.any(Error) },
    );
  });

  it('stays quiet for genuinely missing todos (missing != corrupt)', async () => {
    const id = 'no-todos' as ExecutionId;
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await expect(getExecutionStore(id).readTodos()).resolves.toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns when workspace files are malformed instead of silently defaulting to []', async () => {
    const id = 'bad-wsfiles' as ExecutionId;
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await getExecutionStore(id).write('workspace-files', [42]);

    await expect(getExecutionStore(id).readWorkspaceFiles()).resolves.toEqual(
      [],
    );
    expect(warnSpy).toHaveBeenCalledWith(
      'ExecutionKVStore',
      expect.stringContaining(
        `Failed to parse execution ${id} workspace-files.json`,
      ),
      { data: expect.any(Error) },
    );
  });
});
