import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecutionId } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  exists: vi.fn(),
  clear: vi.fn(),
}));

vi.mock('@utils/files/storageFS', async () => {
  const actual = await vi.importActual<typeof import('@utils/files/storageFS')>(
    '@utils/files/storageFS',
  );
  return {
    ...actual,
    StorageFS: { ...actual.StorageFS, exists: mocks.exists },
  };
});

vi.mock('@agent/storage/ExecutionKVStore', () => ({
  getExecutionStore: vi.fn(() => ({ clear: mocks.clear })),
}));

vi.mock('@agent/storage/executionLease', () => ({
  // `executionListing`'s entrance stamper reads this constant at module load;
  // keep it defined when the lease module is mocked.
  EXECUTION_LEASE_STALE_MS: 120_000,
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

    await expect(
      deleteExecution('a73039a36ec9' as ExecutionId),
    ).resolves.toEqual({
      status: 'deleted',
      executionId: 'a73039a36ec9',
    });
    expect(mocks.clear).toHaveBeenCalledOnce();
  });

  it('runs required cleanup before removing execution storage', async () => {
    mocks.exists.mockResolvedValue(true);
    const beforeDelete = vi.fn(async () => {
      expect(mocks.clear).not.toHaveBeenCalled();
    });

    await expect(
      deleteExecution('a73039a36ec8' as ExecutionId, { beforeDelete }),
    ).resolves.toEqual({
      status: 'deleted',
      executionId: 'a73039a36ec8',
    });
    expect(beforeDelete).toHaveBeenCalledOnce();
    expect(mocks.clear).toHaveBeenCalledOnce();
  });

  it('preserves execution storage when required cleanup fails', async () => {
    mocks.exists.mockResolvedValue(true);

    await expect(
      deleteExecution('a73039a36ec7' as ExecutionId, {
        beforeDelete: async () => {
          throw new Error('sidecar cleanup failed');
        },
      }),
    ).rejects.toThrow('sidecar cleanup failed');
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it('reports when cleanup committed before storage removal failed', async () => {
    mocks.exists.mockResolvedValue(true);
    mocks.clear.mockRejectedValue(new Error('permission denied'));

    await expect(
      deleteExecution('a73039a36ec6' as ExecutionId, {
        beforeDelete: async () => {},
      }),
    ).rejects.toThrow(
      "Execution a73039a36ec6's pre-delete cleanup completed, but its storage directory could not be removed: permission denied",
    );
  });
});
