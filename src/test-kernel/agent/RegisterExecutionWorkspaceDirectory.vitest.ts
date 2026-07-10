/* eslint-disable import/order -- Vitest mocks must be declared before importing the runtime under test. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import * as logger from '@logger/logUtils';
import {
  EXECUTION_STATUS,
  RUN_OUTCOME,
  type ExecutionId,
} from '@shared/schemas';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';

const mocks = vi.hoisted(() => ({
  getExecutionStore: vi.fn(),
  readMeta: vi.fn(),
  readResultMeta: vi.fn(),
  writeConfig: vi.fn(),
  writeMeta: vi.fn(),
  writeResultMeta: vi.fn(),
}));

vi.mock('@agent/storage/ExecutionKVStore', () => ({
  getExecutionStore: mocks.getExecutionStore,
}));

vi.mock('@agent/storage/executionListing', () => ({
  invalidateListingCache: vi.fn(),
}));

import {
  registerExecution,
  synchronizeAgentResultOutcome,
  writeTerminalStatus,
} from '@agent/storage/executionLifecycle';
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

describe('execution lifecycle', () => {
  setupPlatform({ workspacePath: '/workspace/root' });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getExecutionStore.mockReturnValue({
      readMeta: mocks.readMeta,
      readResultMeta: mocks.readResultMeta,
      writeConfig: mocks.writeConfig,
      writeMeta: mocks.writeMeta,
      writeResultMeta: mocks.writeResultMeta,
    });
    mocks.readMeta.mockResolvedValue(null);
    mocks.readResultMeta.mockResolvedValue(null);
    mocks.writeConfig.mockResolvedValue(undefined);
    mocks.writeMeta.mockResolvedValue(undefined);
    mocks.writeResultMeta.mockResolvedValue(undefined);
  });

  it('pins the active workspace path when a config has no working directory', async () => {
    await registerExecution(
      'abc123' as ExecutionId,
      baseConfig,
      'chat',
      undefined,
      'toolUse',
    );

    expect(mocks.writeConfig).toHaveBeenCalledWith({
      ...baseConfig,
      workingDirectory: '/workspace/root',
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
    mocks.readResultMeta.mockResolvedValue({
      producer: 'subagent',
      agentName: 'reviewer',
      wallTimeMs: 20,
      result: {
        category: 'toolUse',
        outcome: 'completed',
        response: 'Interim result.',
        files: [],
        cost: 0.1,
      },
    });

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
    mocks.readResultMeta.mockResolvedValue({
      producer: 'subagent',
      agentName: 'reviewer',
      wallTimeMs: 20,
      result: {
        category: 'toolUse',
        outcome: RUN_OUTCOME.COMPLETED,
        response: 'Interim result.',
        files: [],
        cost: 0.1,
      },
    });

    await synchronizeAgentResultOutcome(executionId, RUN_OUTCOME.CANCELLED);

    expect(mocks.writeResultMeta).toHaveBeenCalledWith({
      producer: 'subagent',
      agentName: 'reviewer',
      wallTimeMs: 20,
      result: {
        category: 'toolUse',
        outcome: RUN_OUTCOME.CANCELLED,
        response: 'Interim result.',
        files: [],
        cost: 0.1,
      },
    });
  });

  it('does not change the result outcome when execution metadata is missing', async () => {
    mocks.readResultMeta.mockResolvedValue({
      producer: 'subagent',
      agentName: 'reviewer',
      wallTimeMs: 20,
      result: {
        category: 'toolUse',
        outcome: 'completed',
        response: 'Finished.',
        files: [],
        cost: 0.1,
      },
    });

    await synchronizeAgentResultOutcome(
      'missing-terminal-meta' as ExecutionId,
      RUN_OUTCOME.CANCELLED,
    );

    expect(mocks.writeMeta).not.toHaveBeenCalled();
    expect(mocks.readResultMeta).not.toHaveBeenCalled();
    expect(mocks.writeResultMeta).not.toHaveBeenCalled();
  });

  it('does not change the result outcome when terminal metadata cannot be written', async () => {
    mocks.readMeta.mockResolvedValue({
      schemaVersion: 1,
      timestamp: '2026-07-10T00:00:00.000Z',
      terminalStatus: EXECUTION_STATUS.COMPLETED,
      outcome: 'completed',
    });
    mocks.readResultMeta.mockResolvedValue({
      producer: 'subagent',
      agentName: 'reviewer',
      wallTimeMs: 20,
      result: {
        category: 'toolUse',
        outcome: 'completed',
        response: 'Finished.',
        files: [],
        cost: 0.1,
      },
    });
    mocks.writeMeta.mockRejectedValueOnce(new Error('disk full'));

    const executionId = 'failed-terminal-write' as ExecutionId;
    await writeTerminalStatus(executionId, EXECUTION_STATUS.INTERRUPTED);
    await synchronizeAgentResultOutcome(executionId, RUN_OUTCOME.CANCELLED);

    expect(mocks.readResultMeta).not.toHaveBeenCalled();
    expect(mocks.writeResultMeta).not.toHaveBeenCalled();
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
    mocks.readResultMeta.mockResolvedValue({
      producer: 'subagent',
      agentName: 'reviewer',
      wallTimeMs: 20,
      result: {
        category: 'toolUse',
        outcome: 'completed',
        response: 'Interim result.',
        files: [],
        cost: 0.1,
      },
    });
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
