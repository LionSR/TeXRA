/* eslint-disable import/order -- Vitest mocks must be declared before importing the runtime under test. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { flowKey } from '@agent/node/persistedFlow';
import {
  RUN_OUTCOME,
  USER_FOLLOW_UP_SUPPORT,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  getExecutionStore: vi.fn(),
  delete: vi.fn(),
  readMeta: vi.fn(),
  readResultMeta: vi.fn(),
  writeRunRecord: vi.fn(),
  writeMeta: vi.fn(),
  writeResultMeta: vi.fn(),
}));

vi.mock('@agent/storage/ExecutionKVStore', () => ({
  getExecutionStore: mocks.getExecutionStore,
}));

import {
  finalizeExecution,
  registerExecution,
} from '@agent/storage/executionLifecycle';
import { inspectExecutionLease } from '@agent/storage/executionLease';
import { setupPlatform } from '@test/support/setupPlatform';

const baseConfig = AgentConfigSchema.parse({
  agent: 'chat',
  model: 'deepseekT',
  instruction: 'Check the proof.',
  agentCategory: 'toolUse',
});

function resultMeta(outcome: string, response: string) {
  return {
    producer: 'subagent',
    agentName: 'reviewer',
    wallTimeMs: 20,
    result: {
      category: 'toolUse',
      outcome,
      response,
      files: [],
      cost: 0.1,
    },
  };
}

function executionMeta(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    timestamp: '2026-07-10T00:00:00.000Z',
    ...overrides,
  };
}

function registrationArgs(
  executionId: ExecutionId,
): Parameters<typeof registerExecution>[3] {
  return {
    streamId: `chat@deepseekT#${executionId}` as StreamTabId,
    identity: { kind: 'agent', agent: 'chat' },
    userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
  };
}

describe('execution lifecycle', () => {
  setupPlatform({ workspacePath: '/workspace/root' });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getExecutionStore.mockReturnValue({
      delete: mocks.delete,
      readMeta: mocks.readMeta,
      readResultMeta: mocks.readResultMeta,
      writeRunRecord: mocks.writeRunRecord,
      writeMeta: mocks.writeMeta,
      writeResultMeta: mocks.writeResultMeta,
    });
    mocks.readMeta.mockResolvedValue(null);
    mocks.readResultMeta.mockResolvedValue(null);
    mocks.delete.mockResolvedValue(undefined);
    mocks.writeRunRecord.mockResolvedValue(undefined);
    mocks.writeMeta.mockResolvedValue(undefined);
    mocks.writeResultMeta.mockResolvedValue(undefined);
  });

  it('pins the active workspace path when a config has no working directory', async () => {
    const executionId = 'abc123' as ExecutionId;
    await registerExecution(
      executionId,
      baseConfig,
      'chat',
      registrationArgs(executionId),
    );

    expect(mocks.writeRunRecord).toHaveBeenCalledWith({
      ...baseConfig,
      workingDirectory: '/workspace/root',
    });
    expect(mocks.writeMeta).toHaveBeenCalledWith({
      schemaVersion: 1,
      timestamp: expect.any(String),
      streamId: 'chat@deepseekT#abc123',
      parentExecutionId: undefined,
      identity: { kind: 'agent', agent: 'chat' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
    });
    await finalizeExecution({
      executionId,
      outcome: RUN_OUTCOME.COMPLETED,
      flowRecord: 'preserve',
    });
  });

  it('preserves an explicit working directory verbatim', async () => {
    const executionId = 'workspace-whitespace' as ExecutionId;
    const workingDirectory = '/workspace/paper ';

    await registerExecution(
      executionId,
      { ...baseConfig, workingDirectory },
      'chat',
      registrationArgs(executionId),
    );

    expect(mocks.writeRunRecord).toHaveBeenCalledWith({
      ...baseConfig,
      workingDirectory,
    });
  });

  it.each([
    {
      name: 'fresh registration fails',
      fail: () =>
        mocks.writeRunRecord.mockRejectedValueOnce(
          new Error('config write failed'),
        ),
      error: 'config write failed',
    },
    {
      name: 'registration preparation throws',
      fail: () =>
        mocks.getExecutionStore.mockImplementationOnce(() => {
          throw new Error('store construction failed');
        }),
      error: 'store construction failed',
    },
  ])('rolls back lease ownership when $name', async ({ fail, error }) => {
    const executionId = 'abc124' as ExecutionId;
    fail();

    await expect(
      registerExecution(
        executionId,
        baseConfig,
        'chat',
        registrationArgs(executionId),
      ),
    ).rejects.toThrow(error);

    await expect(inspectExecutionLease(executionId)).resolves.toEqual({
      status: 'missing',
    });
  });

  it('does not relabel a turn-owned result while persisting terminal metadata', async () => {
    const executionId = 'abc123' as ExecutionId;
    mocks.readMeta.mockResolvedValue(executionMeta({ outcome: 'completed' }));
    mocks.readResultMeta.mockResolvedValue(
      resultMeta('completed', 'Interim result.'),
    );

    await finalizeExecution({
      executionId,
      outcome: RUN_OUTCOME.CANCELLED,
      flowRecord: 'preserve',
    });

    expect(mocks.writeMeta).toHaveBeenCalledWith({
      schemaVersion: 1,
      timestamp: '2026-07-10T00:00:00.000Z',
      outcome: 'cancelled',
    });
    expect(mocks.readResultMeta).not.toHaveBeenCalled();
    expect(mocks.writeResultMeta).not.toHaveBeenCalled();
  });

  it('reports a failure when terminal metadata cannot be written', async () => {
    mocks.readMeta.mockResolvedValue(executionMeta({ outcome: 'completed' }));
    mocks.readResultMeta.mockResolvedValue(
      resultMeta('completed', 'Finished.'),
    );
    const error = new Error('disk full');
    mocks.writeMeta.mockRejectedValueOnce(error);

    const executionId = 'failed-terminal-write' as ExecutionId;
    const result = await finalizeExecution({
      executionId,
      outcome: RUN_OUTCOME.CANCELLED,
      flowRecord: 'preserve',
    });

    expect(result).toEqual({
      status: 'failed',
      error,
      stage: 'terminal-status',
      outcomePersisted: false,
    });
    expect(mocks.readResultMeta).not.toHaveBeenCalled();
    expect(mocks.writeResultMeta).not.toHaveBeenCalled();
  });

  it('finalizes durably while preserving the flow record', async () => {
    const executionId = 'preserved-flow' as ExecutionId;
    mocks.readMeta.mockResolvedValue(executionMeta());

    const result = await finalizeExecution({
      executionId,
      outcome: RUN_OUTCOME.CANCELLED,
      flowRecord: 'preserve',
    });

    expect(result).toEqual({
      status: 'durable',
      outcomePersisted: true,
      flowRecord: 'preserved',
    });
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it('finalizes durably after deleting the flow record', async () => {
    const executionId = 'deleted-flow' as ExecutionId;
    mocks.readMeta.mockResolvedValue(executionMeta());

    const result = await finalizeExecution({
      executionId,
      outcome: RUN_OUTCOME.COMPLETED,
      flowRecord: 'delete',
    });

    expect(result).toEqual({
      status: 'durable',
      outcomePersisted: true,
      flowRecord: 'deleted',
    });
    expect(mocks.delete).toHaveBeenCalledWith(flowKey(executionId));
  });

  it('deletes the flow record when failed terminal metadata cannot persist', async () => {
    const executionId = 'metadata-failed-flow' as ExecutionId;
    const error = new Error('metadata disk full');
    mocks.readMeta.mockRejectedValueOnce(error);

    const result = await finalizeExecution({
      executionId,
      outcome: RUN_OUTCOME.FAILED,
      flowRecord: 'delete',
    });

    expect(result).toEqual({
      status: 'failed',
      error,
      stage: 'terminal-status',
      outcomePersisted: false,
    });
    expect(mocks.delete).toHaveBeenCalledWith(flowKey(executionId));
  });

  it('reports when terminal metadata and fail-closed flow deletion both fail', async () => {
    const executionId = 'metadata-and-flow-failed' as ExecutionId;
    mocks.readMeta.mockRejectedValueOnce(new Error('metadata disk full'));
    mocks.delete.mockRejectedValueOnce(new Error('flow delete failed'));

    const result = await finalizeExecution({
      executionId,
      outcome: RUN_OUTCOME.FAILED,
      flowRecord: 'preserve',
    });

    expect(result).toMatchObject({
      status: 'failed',
      stage: 'terminal-status-and-flow-record-delete',
      outcomePersisted: false,
      error: expect.any(AggregateError),
    });
    expect(mocks.delete).toHaveBeenCalledWith(flowKey(executionId));
  });

  it('reports durable terminal metadata when flow deletion fails', async () => {
    const executionId = 'flow-delete-failed' as ExecutionId;
    const error = new Error('flow delete failed');
    mocks.readMeta.mockResolvedValue(executionMeta());
    mocks.delete.mockRejectedValueOnce(error);

    const result = await finalizeExecution({
      executionId,
      outcome: RUN_OUTCOME.FAILED,
      flowRecord: 'delete',
    });

    expect(result).toEqual({
      status: 'failed',
      error,
      stage: 'flow-record-delete',
      outcomePersisted: true,
    });
    expect(mocks.writeMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: RUN_OUTCOME.FAILED,
      }),
    );
    expect(mocks.delete).toHaveBeenCalledWith(flowKey(executionId));
  });
});
