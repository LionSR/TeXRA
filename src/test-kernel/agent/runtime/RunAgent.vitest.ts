import { afterEach, describe, expect, it, vi } from 'vitest';

const storageMock = vi.hoisted(() => ({
  registerExecution: vi.fn(),
}));

const executeAgentMock = vi.hoisted(() => ({
  executeAgent: vi.fn(),
}));

const historyCommandsMock = vi.hoisted(() => ({
  repairRuntimeHistoryTerminalStatus: vi.fn(),
}));

vi.mock('@agent/storage', () => storageMock);
vi.mock('@agent/runtime/executeAgent', () => executeAgentMock);
vi.mock('@agent/runtime/historyCommands', () => historyCommandsMock);
vi.mock('@utils/core/executionId', () => ({
  generateExecutionId: () => 'generated123456',
}));

import { runAgent } from '@agent/runtime/runAgent';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { EXECUTION_STATUS, type ExecutionId } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas/agent';

const config = AgentConfigSchema.parse({
  agent: 'proof',
  model: 'deepseekT',
  agentCategory: AgentCategory.ToolUse,
});

const runtimeHost = { emit: vi.fn() };

describe('runAgent history repair', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('repairs terminal history when execution fails after fresh registration', async () => {
    const failure = new Error('launch failed');
    storageMock.registerExecution.mockResolvedValue(undefined);
    historyCommandsMock.repairRuntimeHistoryTerminalStatus.mockResolvedValue({
      status: 'written',
      terminalStatus: EXECUTION_STATUS.ERROR,
    });
    executeAgentMock.executeAgent.mockRejectedValue(failure);

    await expect(runAgent({ config }, { runtimeHost })).rejects.toThrow(
      'launch failed',
    );

    expect(storageMock.registerExecution).toHaveBeenCalledWith(
      'generated123456',
      config,
      'proof',
      undefined,
      AgentCategory.ToolUse,
    );
    expect(
      historyCommandsMock.repairRuntimeHistoryTerminalStatus,
    ).toHaveBeenCalledWith('generated123456', EXECUTION_STATUS.ERROR);
  });

  it('repairs terminal history for existing execution ids', async () => {
    const executionId = 'existing123456' as ExecutionId;
    executeAgentMock.executeAgent.mockRejectedValue(new Error('resume failed'));

    await expect(
      runAgent({ config, executionId }, { runtimeHost }),
    ).rejects.toThrow('resume failed');

    expect(storageMock.registerExecution).not.toHaveBeenCalled();
    expect(
      historyCommandsMock.repairRuntimeHistoryTerminalStatus,
    ).toHaveBeenCalledWith(executionId, EXECUTION_STATUS.ERROR);
  });

  it('does not repair history when no execution record can exist', async () => {
    executeAgentMock.executeAgent.mockRejectedValue(new Error('headless fail'));

    await expect(
      runAgent({ config }, { runtimeHost, registerExecution: false }),
    ).rejects.toThrow('headless fail');

    expect(storageMock.registerExecution).not.toHaveBeenCalled();
    expect(
      historyCommandsMock.repairRuntimeHistoryTerminalStatus,
    ).not.toHaveBeenCalled();
  });

  it('does not treat workflow output presentation failures as run failures', async () => {
    const workflowResult = {
      category: 'workflow',
      outcome: 'completed',
      outputs: [],
      compileFailures: [],
      executionId: 'generated123456',
      streamId: 'stream:workflow',
    };
    storageMock.registerExecution.mockResolvedValue(undefined);
    executeAgentMock.executeAgent.mockResolvedValue(workflowResult);

    await expect(
      runAgent(
        { config: { ...config, agentCategory: AgentCategory.Workflow } },
        {
          runtimeHost,
          openWorkflowOutput: vi.fn(async () => {
            throw new Error('display failed');
          }),
        },
      ),
    ).rejects.toThrow('display failed');

    expect(
      historyCommandsMock.repairRuntimeHistoryTerminalStatus,
    ).not.toHaveBeenCalled();
  });
});
