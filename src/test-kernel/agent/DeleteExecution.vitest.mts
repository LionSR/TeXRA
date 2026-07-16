import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecutionId } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  exists: vi.fn(),
  clear: vi.fn(),
}));

vi.mock('@utils/files', async () => {
  const actual =
    await vi.importActual<typeof import('@utils/files')>('@utils/files');
  return {
    ...actual,
    StorageFS: { ...actual.StorageFS, exists: mocks.exists },
  };
});

vi.mock('@agent/storage/ExecutionKVStore', () => ({
  getExecutionStore: vi.fn(() => ({ clear: mocks.clear })),
}));

vi.mock('@agent/storage/executionLease', () => ({
  runWithInactiveExecutionLease: vi.fn(
    async (_executionId: ExecutionId, operation: () => Promise<unknown>) => ({
      status: 'performed',
      value: await operation(),
    }),
  ),
}));

// Imported after vi.mock so the mocked ExecutionKVStore is in place.
// eslint-disable-next-line import/order
import { deleteExecution } from '@agent/storage/executionListing';

beforeEach(() => {
  mocks.exists.mockReset();
  mocks.clear.mockReset();
});

describe('deleteExecution', () => {
  it('reports not-found without calling clear when the execution directory is missing', async () => {
    mocks.exists.mockResolvedValue(false);
    mocks.clear.mockResolvedValue(undefined);

    await expect(
      deleteExecution('deadbeef0000' as ExecutionId),
    ).resolves.toEqual({
      status: 'not-found',
      executionId: 'deadbeef0000',
    });

    // The probe asked about the right path.
    expect(mocks.exists).toHaveBeenCalledWith('executions/deadbeef0000');
    // Critical: clear() must NOT run on a missing id — otherwise the silent
    // no-op behaviour of `deleteDir` makes us report "Deleted" for typos.
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it('reports deletion and clears storage when the execution directory exists', async () => {
    mocks.exists.mockResolvedValue(true);
    mocks.clear.mockResolvedValue(undefined);

    await expect(
      deleteExecution('a73039a36ec9' as ExecutionId),
    ).resolves.toEqual({
      status: 'deleted',
      executionId: 'a73039a36ec9',
    });
    expect(mocks.clear).toHaveBeenCalledTimes(1);
  });

  it('removes execution storage before adjacent state', async () => {
    mocks.exists.mockResolvedValue(true);
    mocks.clear.mockResolvedValue(undefined);
    const afterDelete = vi.fn(async () => {
      expect(mocks.clear).toHaveBeenCalledOnce();
    });

    await expect(
      deleteExecution('a73039a36eca' as ExecutionId, { afterDelete }),
    ).resolves.toEqual({
      status: 'deleted',
      executionId: 'a73039a36eca',
    });
    expect(afterDelete).toHaveBeenCalledOnce();
  });

  it('leaves adjacent state untouched when execution deletion fails', async () => {
    mocks.exists.mockResolvedValue(true);
    mocks.clear.mockRejectedValue(new Error('permission denied'));
    const afterDelete = vi.fn();

    await expect(
      deleteExecution('a73039a36ecb' as ExecutionId, { afterDelete }),
    ).rejects.toThrow('permission denied');
    expect(afterDelete).not.toHaveBeenCalled();
  });

  it('reports adjacent cleanup failure after execution deletion succeeds', async () => {
    mocks.exists.mockResolvedValue(true);
    mocks.clear.mockResolvedValue(undefined);

    await expect(
      deleteExecution('a73039a36ecc' as ExecutionId, {
        afterDelete: async () => {
          throw new Error('sidecar cleanup failed');
        },
      }),
    ).resolves.toEqual({
      status: 'deleted',
      executionId: 'a73039a36ecc',
      adjacentCleanupFailure: 'sidecar cleanup failed',
    });
  });
});
