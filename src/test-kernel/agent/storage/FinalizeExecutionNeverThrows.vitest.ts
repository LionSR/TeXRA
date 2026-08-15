/* eslint-disable import/order -- Vitest mocks must be declared before importing the runtime under test. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flowKey } from '@agent/node/persistedFlow';
import { RUN_OUTCOME, type ExecutionId } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  getExecutionStore: vi.fn(),
  delete: vi.fn(),
  readMeta: vi.fn(),
  writeMeta: vi.fn(),
}));

vi.mock('@agent/storage/ExecutionKVStore', () => ({
  getExecutionStore: mocks.getExecutionStore,
}));

import { finalizeExecution } from '@agent/storage/executionLifecycle';
import { setupPlatform } from '@test/support/setupPlatform';

const executionId = 'finalize-never-throws' as ExecutionId;

function registeredMeta() {
  return {
    schemaVersion: 1,
    timestamp: '2026-08-15T00:00:00.000Z',
  };
}

/**
 * Guard for the never-throws contract #10603 made load-bearing: the catchless
 * callers in `terminalPersistence`, `runAgent`, and the CLI's
 * `executionFinalization` await `finalizeExecution` with no catch arm, so a
 * rejection would escape as an unhandled failure instead of being reported as
 * a durability failure. Every test injects a rejecting or throwing store
 * dependency — the terminal-status write, the flow-record cleanup delete, or
 * store resolution itself — and asserts the call still RESOLVES a 'failed'
 * result carrying the underlying error (#10614).
 */
describe('finalizeExecution never-throws contract (#10614)', () => {
  setupPlatform({ workspacePath: '/workspace' });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getExecutionStore.mockReturnValue({
      delete: mocks.delete,
      readMeta: mocks.readMeta,
      writeMeta: mocks.writeMeta,
    });
    mocks.readMeta.mockResolvedValue(registeredMeta());
    mocks.writeMeta.mockResolvedValue(undefined);
    mocks.delete.mockResolvedValue(undefined);
  });

  it('resolves durable when every store write succeeds', async () => {
    await expect(
      finalizeExecution({
        executionId,
        outcome: RUN_OUTCOME.COMPLETED,
        flowRecord: 'preserve',
      }),
    ).resolves.toEqual({
      status: 'durable',
      outcomePersisted: true,
      flowRecord: 'preserved',
    });
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it('resolves failed when the terminal-status write rejects under a delete policy', async () => {
    const writeError = new Error('meta write rejected');
    mocks.writeMeta.mockRejectedValueOnce(writeError);

    await expect(
      finalizeExecution({
        executionId,
        outcome: RUN_OUTCOME.CANCELLED,
        flowRecord: 'delete',
      }),
    ).resolves.toEqual({
      status: 'failed',
      error: writeError,
      stage: 'terminal-status',
      outcomePersisted: false,
    });
    // The requested flow-record delete still ran, failing closed.
    expect(mocks.delete).toHaveBeenCalledWith(flowKey(executionId));
  });

  it('resolves failed without touching the flow record for a preserved non-terminal outcome', async () => {
    const writeError = new Error('meta write rejected');
    mocks.writeMeta.mockRejectedValueOnce(writeError);

    await expect(
      finalizeExecution({
        executionId,
        outcome: RUN_OUTCOME.CANCELLED,
        flowRecord: 'preserve',
      }),
    ).resolves.toEqual({
      status: 'failed',
      error: writeError,
      stage: 'terminal-status',
      outcomePersisted: false,
    });
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it('resolves failed and still deletes fail-closed for a preserved terminal outcome', async () => {
    const writeError = new Error('meta write rejected');
    mocks.writeMeta.mockRejectedValueOnce(writeError);

    await expect(
      finalizeExecution({
        executionId,
        outcome: RUN_OUTCOME.COMPLETED,
        flowRecord: 'preserve',
      }),
    ).resolves.toEqual({
      status: 'failed',
      error: writeError,
      stage: 'terminal-status',
      outcomePersisted: false,
    });
    // A terminal COMPLETED/FAILED outcome must never retain a resumable flow,
    // so the cleanup delete runs even though the caller asked to preserve.
    expect(mocks.delete).toHaveBeenCalledWith(flowKey(executionId));
  });

  it('resolves failed with an AggregateError when the fail-closed delete also rejects', async () => {
    const writeError = new Error('meta write rejected');
    const deleteError = new Error('flow delete rejected');
    mocks.writeMeta.mockRejectedValueOnce(writeError);
    mocks.delete.mockRejectedValueOnce(deleteError);

    const finalization = finalizeExecution({
      executionId,
      outcome: RUN_OUTCOME.FAILED,
      flowRecord: 'preserve',
    });
    await expect(finalization).resolves.toMatchObject({
      status: 'failed',
      stage: 'terminal-status-and-flow-record-delete',
      outcomePersisted: false,
      error: expect.any(AggregateError),
    });
    const result = await finalization;
    if (result.status === 'durable') {
      throw new Error('expected a failed finalization result');
    }
    expect((result.error as AggregateError).errors).toEqual([
      writeError,
      deleteError,
    ]);
  });

  it('resolves failed when store resolution itself throws under a delete policy', async () => {
    mocks.getExecutionStore.mockImplementation(() => {
      throw new Error('store construction failed');
    });

    await expect(
      finalizeExecution({
        executionId,
        outcome: RUN_OUTCOME.FAILED,
        flowRecord: 'delete',
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      stage: 'terminal-status-and-flow-record-delete',
      outcomePersisted: false,
      error: expect.any(AggregateError),
    });
  });

  it('resolves failed when store resolution itself throws under a preserve policy', async () => {
    const constructionError = new Error('store construction failed');
    mocks.getExecutionStore.mockImplementation(() => {
      throw constructionError;
    });

    await expect(
      finalizeExecution({
        executionId,
        outcome: RUN_OUTCOME.CANCELLED,
        flowRecord: 'preserve',
      }),
    ).resolves.toEqual({
      status: 'failed',
      error: constructionError,
      stage: 'terminal-status',
      outcomePersisted: false,
    });
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it('resolves failed with the outcome persisted when only the flow-record delete rejects', async () => {
    const deleteError = new Error('flow delete rejected');
    mocks.delete.mockRejectedValueOnce(deleteError);

    await expect(
      finalizeExecution({
        executionId,
        outcome: RUN_OUTCOME.COMPLETED,
        flowRecord: 'delete',
      }),
    ).resolves.toEqual({
      status: 'failed',
      error: deleteError,
      stage: 'flow-record-delete',
      outcomePersisted: true,
    });
    expect(mocks.writeMeta).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: RUN_OUTCOME.COMPLETED }),
    );
  });

  it('resolves failed when the execution has no persisted metadata', async () => {
    mocks.readMeta.mockResolvedValue(null);

    await expect(
      finalizeExecution({
        executionId,
        outcome: RUN_OUTCOME.CANCELLED,
        flowRecord: 'preserve',
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      stage: 'terminal-status',
      outcomePersisted: false,
      error: expect.objectContaining({
        message: expect.stringContaining('metadata not found'),
      }),
    });
    expect(mocks.writeMeta).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });
});
