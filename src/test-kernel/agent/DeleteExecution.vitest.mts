import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecutionId } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  exists: vi.fn(),
  clear: vi.fn(),
  invalidateListingCache: vi.fn(),
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
  EXECUTIONS_DIR: 'executions',
  getExecutionStore: vi.fn(() => ({ clear: mocks.clear })),
}));

import { deleteExecution } from '@agent/storage/executionListing';

beforeEach(() => {
  mocks.exists.mockReset();
  mocks.clear.mockReset();
});

describe('deleteExecution', () => {
  it('returns false without calling clear when the execution directory is missing', async () => {
    mocks.exists.mockResolvedValue(false);
    mocks.clear.mockResolvedValue(undefined);

    await expect(deleteExecution('deadbeef0000' as ExecutionId)).resolves.toBe(
      false,
    );

    // The probe asked about the right path.
    expect(mocks.exists).toHaveBeenCalledWith('executions/deadbeef0000');
    // Critical: clear() must NOT run on a missing id — otherwise the silent
    // no-op behaviour of `deleteDir` makes us report "Deleted" for typos.
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it('returns true and clears storage when the execution directory exists', async () => {
    mocks.exists.mockResolvedValue(true);
    mocks.clear.mockResolvedValue(undefined);

    await expect(deleteExecution('a73039a36ec9' as ExecutionId)).resolves.toBe(
      true,
    );
    expect(mocks.clear).toHaveBeenCalledTimes(1);
  });
});
