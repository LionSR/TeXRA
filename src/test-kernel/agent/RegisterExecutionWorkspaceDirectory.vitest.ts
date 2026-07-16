/* eslint-disable import/order -- Vitest mocks must be declared before importing the runtime under test. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { flowKey } from '@agent/node/persistedFlow';
import * as logger from '@logger/logUtils';
import {
  EXECUTION_STATUS,
  RUN_OUTCOME,
  type ExecutionId,
} from '@shared/schemas';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';

const mocks = vi.hoisted(() => ({
  getExecutionStore: vi.fn(),
  delete: vi.fn(),
  readMeta: vi.fn(),
  readResultMeta: vi.fn(),
  writeConfig: vi.fn(),
  writeMeta: vi.fn(),
  writeResultMeta: vi.fn(),
}));

vi.mock('@agent/storage/ExecutionKVStore', () => ({
  getExecutionStore: mocks.getExecutionStore,
}));

import {
  finalizeExecution,
  registerExecution,
  synchronizeAgentResultOutcome,
  writeTerminalStatus,
} from '@agent/storage/executionLifecycle';
import { inspectExecutionLease } from '@agent/storage/executionLease';
import { setupPlatform } from '@test/support/setupPlatform';

const baseConfig = {
  agent: 'chat',
  model: 'deepseekT',
  instruction: 'Check the proof.',
  agentCategory: 'toolUse',
  inputFiles: [],
  outputFiles: [],
  contextFiles: [],
  mediaFiles: [],
  editedFile: null,
  editedFiles: [],
  memories: [],
  toolConfig: DEFAULT_TOOL_CONFIG,
} as AgentConfig;

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

describe('execution lifecycle', () => {
  setupPlatform({ workspacePath: '/workspace/root' });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getExecutionStore.mockReturnValue({
      delete: mocks.delete,
      readMeta: mocks.readMeta,
      readResultMeta: mocks.readResultMeta,
      writeConfig: mocks.writeConfig,
      writeMeta: mocks.writeMeta,
      writeResultMeta: mocks.writeResultMeta,
    });
    mocks.readMeta.mockResolvedValue(null);
    mocks.readResultMeta.mockResolvedValue(null);
    mocks.delete.mockResolvedValue(undefined);
    mocks.writeConfig.mockResolvedValue(undefined);
    mocks.writeMeta.mockResolvedValue(undefined);
    mocks.writeResultMeta.mockResolvedValue(undefined);
  });

  it('pins the active workspace path when a config has no working directory', async () => {
    const executionId = 'abc123' as ExecutionId;
    await registerExecution(
      executionId,
      baseConfig,
      'chat',
      undefined,
      'toolUse',
    );

    expect(mocks.writeConfig).toHaveBeenCalledWith({
      ...baseConfig,
      workingDirectory: '/workspace/root',
    });
    await finalizeExecution({
      executionId,
      terminalStatus: EXECUTION_STATUS.COMPLETED,
      flowRecord: 'preserve',
    });
  });

  it('rolls back lease ownership when fresh registration fails', async () => {
    const executionId = 'abc124' as ExecutionId;
    mocks.writeConfig.mockRejectedValueOnce(new Error('config write failed'));

    await expect(
      registerExecution(executionId, baseConfig, 'chat'),
    ).rejects.toThrow('config write failed');

    await expect(inspectExecutionLease(executionId)).resolves.toEqual({
      status: 'missing',
    });
  });

  it('rolls back lease ownership when registration preparation throws', async () => {
    const executionId = 'abc125' as ExecutionId;
    mocks.getExecutionStore.mockImplementationOnce(() => {
      throw new Error('store construction failed');
    });

    await expect(
      registerExecution(executionId, baseConfig, 'chat'),
    ).rejects.toThrow('store construction failed');
    await expect(inspectExecutionLease(executionId)).resolves.toEqual({
      status: 'missing',
    });
  });

  it('does not relabel a turn-owned result while persisting terminal metadata', async () => {
    const executionId = 'abc123' as ExecutionId;
    mocks.readMeta.mockResolvedValue({
      schemaVersion: 1,
      timestamp: '2026-07-10T00:00:00.000Z',
      terminalStatus: EXECUTION_STATUS.COMPLETED,
      outcome: 'completed',
    });
    mocks.readResultMeta.mockResolvedValue(
      resultMeta('completed', 'Interim result.'),
    );

    await writeTerminalStatus(executionId, EXECUTION_STATUS.INTERRUPTED);

    expect(mocks.writeMeta).toHaveBeenCalledWith({
      schemaVersion: 1,
      timestamp: '2026-07-10T00:00:00.000Z',
      terminalStatus: EXECUTION_STATUS.INTERRUPTED,
      outcome: 'cancelled',
    });
    expect(mocks.readResultMeta).not.toHaveBeenCalled();
    expect(mocks.writeResultMeta).not.toHaveBeenCalled();
  });

  it('aligns an interim result after a suspended run terminates between turns', async () => {
    const executionId = 'suspended-terminal-result' as ExecutionId;
    mocks.readMeta.mockResolvedValue({
      schemaVersion: 1,
      timestamp: '2026-07-10T00:00:00.000Z',
      terminalStatus: EXECUTION_STATUS.INTERRUPTED,
      outcome: RUN_OUTCOME.CANCELLED,
    });
    mocks.readResultMeta.mockResolvedValue(
      resultMeta(RUN_OUTCOME.COMPLETED, 'Interim result.'),
    );

    await synchronizeAgentResultOutcome(executionId, RUN_OUTCOME.CANCELLED);

    expect(mocks.writeResultMeta).toHaveBeenCalledWith(
      resultMeta(RUN_OUTCOME.CANCELLED, 'Interim result.'),
    );
  });

  it('does not change the result outcome when execution metadata is missing', async () => {
    mocks.readResultMeta.mockResolvedValue(
      resultMeta('completed', 'Finished.'),
    );

    await synchronizeAgentResultOutcome(
      'missing-terminal-meta' as ExecutionId,
      RUN_OUTCOME.CANCELLED,
    );

    expect(mocks.writeMeta).not.toHaveBeenCalled();
    expect(mocks.readResultMeta).not.toHaveBeenCalled();
    expect(mocks.writeResultMeta).not.toHaveBeenCalled();
  });

  it('rejects when terminal metadata cannot be written', async () => {
    mocks.readMeta.mockResolvedValue({
      schemaVersion: 1,
      timestamp: '2026-07-10T00:00:00.000Z',
      terminalStatus: EXECUTION_STATUS.COMPLETED,
      outcome: 'completed',
    });
    mocks.readResultMeta.mockResolvedValue(
      resultMeta('completed', 'Finished.'),
    );
    mocks.writeMeta.mockRejectedValueOnce(new Error('disk full'));

    const executionId = 'failed-terminal-write' as ExecutionId;
    await expect(
      writeTerminalStatus(executionId, EXECUTION_STATUS.INTERRUPTED),
    ).rejects.toThrow('disk full');

    expect(mocks.readResultMeta).not.toHaveBeenCalled();
    expect(mocks.writeResultMeta).not.toHaveBeenCalled();
  });

  it('finalizes durably while preserving the flow record', async () => {
    const executionId = 'preserved-flow' as ExecutionId;
    mocks.readMeta.mockResolvedValue({
      schemaVersion: 1,
      timestamp: '2026-07-10T00:00:00.000Z',
    });

    const result = await finalizeExecution({
      executionId,
      terminalStatus: EXECUTION_STATUS.INTERRUPTED,
      flowRecord: 'preserve',
    });

    expect(result).toEqual({
      status: 'durable',
      terminalStatusPersisted: true,
      flowRecord: 'preserved',
    });
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it('finalizes durably after deleting the flow record', async () => {
    const executionId = 'deleted-flow' as ExecutionId;
    mocks.readMeta.mockResolvedValue({
      schemaVersion: 1,
      timestamp: '2026-07-10T00:00:00.000Z',
    });

    const result = await finalizeExecution({
      executionId,
      terminalStatus: EXECUTION_STATUS.COMPLETED,
      flowRecord: 'delete',
    });

    expect(result).toEqual({
      status: 'durable',
      terminalStatusPersisted: true,
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
      terminalStatus: EXECUTION_STATUS.ERROR,
      flowRecord: 'delete',
    });

    expect(result).toEqual({
      status: 'failed',
      error,
      stage: 'terminal-status',
      terminalStatusPersisted: false,
    });
    expect(mocks.delete).toHaveBeenCalledWith(flowKey(executionId));
  });

  it('reports when terminal metadata and fail-closed flow deletion both fail', async () => {
    const executionId = 'metadata-and-flow-failed' as ExecutionId;
    mocks.readMeta.mockRejectedValueOnce(new Error('metadata disk full'));
    mocks.delete.mockRejectedValueOnce(new Error('flow delete failed'));

    const result = await finalizeExecution({
      executionId,
      terminalStatus: EXECUTION_STATUS.ERROR,
      flowRecord: 'preserve',
    });

    expect(result).toMatchObject({
      status: 'failed',
      stage: 'terminal-status-and-flow-record-delete',
      terminalStatusPersisted: false,
      error: expect.any(AggregateError),
    });
    expect(mocks.delete).toHaveBeenCalledWith(flowKey(executionId));
  });

  it('reports durable terminal metadata when flow deletion fails', async () => {
    const executionId = 'flow-delete-failed' as ExecutionId;
    const error = new Error('flow delete failed');
    mocks.readMeta.mockResolvedValue({
      schemaVersion: 1,
      timestamp: '2026-07-10T00:00:00.000Z',
    });
    mocks.delete.mockRejectedValueOnce(error);

    const result = await finalizeExecution({
      executionId,
      terminalStatus: EXECUTION_STATUS.ERROR,
      flowRecord: 'delete',
    });

    expect(result).toEqual({
      status: 'failed',
      error,
      stage: 'flow-record-delete',
      terminalStatusPersisted: true,
    });
    expect(mocks.writeMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalStatus: EXECUTION_STATUS.ERROR,
        outcome: RUN_OUTCOME.FAILED,
      }),
    );
    expect(mocks.delete).toHaveBeenCalledWith(flowKey(executionId));
  });

  it('warns when the persisted result outcome cannot be reconciled', async () => {
    const executionId = 'result-sync-failed' as ExecutionId;
    const error = new Error('result disk full');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    mocks.readMeta.mockResolvedValue({
      schemaVersion: 1,
      timestamp: '2026-07-10T00:00:00.000Z',
      outcome: RUN_OUTCOME.CANCELLED,
    });
    mocks.readResultMeta.mockResolvedValue(
      resultMeta('completed', 'Interim result.'),
    );
    mocks.writeResultMeta.mockRejectedValueOnce(error);

    try {
      await synchronizeAgentResultOutcome(executionId, RUN_OUTCOME.CANCELLED);

      expect(warnSpy).toHaveBeenCalledWith(
        'ExecutionLifecycle',
        expect.stringContaining(
          `Failed to synchronize result outcome for ${executionId}`,
        ),
        { data: error },
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
