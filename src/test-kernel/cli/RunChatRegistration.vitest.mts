import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  buildInitialChatAgentConfig,
  markRegisteredChatExecutionError,
  registerFreshChatExecution,
} from '@cli/chat/chatSessionController';
import { EXECUTION_STATUS, type ExecutionId } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  finalizeExecution: vi.fn(),
  reportFinalizationFailure: vi.fn(),
  registerExecution: vi.fn(),
}));

vi.mock('@agent/storage', async () => {
  const actual =
    await vi.importActual<typeof import('@agent/storage')>('@agent/storage');
  return {
    ...actual,
    finalizeExecution: mocks.finalizeExecution,
    registerExecution: mocks.registerExecution,
  };
});

describe('CLI chat execution registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.finalizeExecution.mockResolvedValue({
      status: 'durable',
      terminalStatusPersisted: true,
      flowRecord: 'deleted',
    });
    mocks.registerExecution.mockResolvedValue(undefined);
  });

  it('registers fresh chat executions so resume/history can resolve them', async () => {
    const executionId = 'abc123' as ExecutionId;
    const config = buildInitialChatAgentConfig({
      agent: 'chat',
      model: 'gpt54',
      instruction: 'Prove a compactness lemma.',
      workingDirectory: '/tmp/texra-chat',
    });

    const registered = await registerFreshChatExecution(executionId, config);

    expect(registered).toMatchObject({
      agent: 'chat',
      model: 'gpt54',
      instruction: 'Prove a compactness lemma.',
      workingDirectory: '/tmp/texra-chat',
      agentCategory: AgentCategory.ToolUse,
    });
    expect(mocks.registerExecution).toHaveBeenCalledWith(
      executionId,
      registered,
      'chat',
    );
  });

  it('marks registered chat executions as errored when launch throws', async () => {
    const executionId = 'registered' as ExecutionId;

    await markRegisteredChatExecutionError(executionId, {
      executionRegistered: true,
      agentSettled: false,
      reportFinalizationFailure: mocks.reportFinalizationFailure,
    });

    expect(mocks.finalizeExecution).toHaveBeenCalledWith({
      executionId,
      terminalStatus: EXECUTION_STATUS.ERROR,
      flowRecord: 'delete',
    });
  });

  it('does not mark launch errors before registration succeeds', async () => {
    const executionId = 'unregistered' as ExecutionId;

    await markRegisteredChatExecutionError(executionId, {
      executionRegistered: false,
      agentSettled: false,
      reportFinalizationFailure: mocks.reportFinalizationFailure,
    });

    expect(mocks.finalizeExecution).not.toHaveBeenCalled();
  });

  it('does not overwrite terminal status after the agent has settled', async () => {
    const executionId = 'completed' as ExecutionId;

    await markRegisteredChatExecutionError(executionId, {
      executionRegistered: true,
      agentSettled: true,
      reportFinalizationFailure: mocks.reportFinalizationFailure,
    });

    expect(mocks.finalizeExecution).not.toHaveBeenCalled();
  });

  it('reports finalization failures without rejecting the chat error path', async () => {
    const executionId = 'registered' as ExecutionId;
    const persistenceError = new Error('terminal metadata disk full');
    mocks.finalizeExecution.mockResolvedValueOnce({
      status: 'failed',
      error: persistenceError,
      stage: 'terminal-status',
      terminalStatusPersisted: false,
    });

    await expect(
      markRegisteredChatExecutionError(executionId, {
        executionRegistered: true,
        agentSettled: false,
        reportFinalizationFailure: mocks.reportFinalizationFailure,
      }),
    ).resolves.toBeUndefined();

    expect(mocks.reportFinalizationFailure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message:
          'Failed to persist error status for execution registered: terminal metadata disk full',
        cause: persistenceError,
      }),
    );
  });
});
