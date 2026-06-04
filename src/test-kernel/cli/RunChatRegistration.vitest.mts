import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  buildInitialChatAgentConfig,
  markRegisteredChatExecutionError,
  registerFreshChatExecution,
} from '@cli/chat/tui/runChatTui';
import { EXECUTION_STATUS, type ExecutionId } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  registerExecution: vi.fn(),
  writeTerminalStatus: vi.fn(),
}));

vi.mock('@agent/storage', async () => {
  const actual =
    await vi.importActual<typeof import('@agent/storage')>('@agent/storage');
  return {
    ...actual,
    registerExecution: mocks.registerExecution,
    writeTerminalStatus: mocks.writeTerminalStatus,
  };
});

describe('CLI chat execution registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.registerExecution.mockResolvedValue(undefined);
    mocks.writeTerminalStatus.mockResolvedValue(undefined);
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
    });

    expect(mocks.writeTerminalStatus).toHaveBeenCalledWith(
      executionId,
      EXECUTION_STATUS.ERROR,
    );
  });

  it('does not mark launch errors before registration succeeds', async () => {
    const executionId = 'unregistered' as ExecutionId;

    await markRegisteredChatExecutionError(executionId, {
      executionRegistered: false,
      agentSettled: false,
    });

    expect(mocks.writeTerminalStatus).not.toHaveBeenCalled();
  });

  it('does not overwrite terminal status after the agent has settled', async () => {
    const executionId = 'completed' as ExecutionId;

    await markRegisteredChatExecutionError(executionId, {
      executionRegistered: true,
      agentSettled: true,
    });

    expect(mocks.writeTerminalStatus).not.toHaveBeenCalled();
  });
});
