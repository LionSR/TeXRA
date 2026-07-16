import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeAgent: vi.fn(),
  finalizeExecution: vi.fn(),
  registerExecution: vi.fn(),
  releaseOwnedExecutionLeaseBestEffort: vi.fn(),
}));

vi.mock('@agent/storage', () => ({
  finalizeExecution: mocks.finalizeExecution,
  registerExecution: mocks.registerExecution,
  releaseOwnedExecutionLeaseBestEffort:
    mocks.releaseOwnedExecutionLeaseBestEffort,
}));

vi.mock('@agent/runtime/executeAgent', () => ({
  executeAgent: mocks.executeAgent,
}));

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { runAgent } from '@agent/runtime/runAgent';
import { EXECUTION_STATUS, type ExecutionId } from '@shared/schemas';

const EXECUTION_ID = 'run-agent-owner' as ExecutionId;
const CONFIG = AgentConfigSchema.parse({
  agent: 'assistant',
  agentCategory: 'toolUse',
  model: 'test-model',
});
const RUNTIME_HOST = { emit: vi.fn() } as never;

describe('runAgent execution ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.registerExecution.mockResolvedValue(undefined);
    mocks.releaseOwnedExecutionLeaseBestEffort.mockResolvedValue(undefined);
    mocks.finalizeExecution.mockResolvedValue({
      status: 'durable',
      terminalStatusPersisted: true,
      flowRecord: 'deleted',
    });
    mocks.executeAgent.mockResolvedValue({
      category: 'toolUse',
      executionId: EXECUTION_ID,
      streamId: EXECUTION_ID,
      outcome: 'COMPLETED',
    });
  });

  it('registers and releases an explicitly identified fresh run', async () => {
    await runAgent(
      { config: CONFIG, executionId: EXECUTION_ID },
      { runtimeHost: RUNTIME_HOST, registerExecution: true },
    );

    expect(mocks.registerExecution).toHaveBeenCalledOnce();
    expect(mocks.executeAgent).toHaveBeenCalledOnce();
    expect(mocks.releaseOwnedExecutionLeaseBestEffort).toHaveBeenCalledWith(
      EXECUTION_ID,
    );
  });

  it('persists an early launch error before releasing ownership', async () => {
    const order: string[] = [];
    const launchError = new Error('launch failed');
    mocks.executeAgent.mockRejectedValueOnce(launchError);
    mocks.finalizeExecution.mockImplementationOnce(async () => {
      order.push('finalize');
      return {
        status: 'durable',
        terminalStatusPersisted: true,
        flowRecord: 'deleted',
      };
    });
    mocks.releaseOwnedExecutionLeaseBestEffort.mockImplementationOnce(
      async () => {
        order.push('release');
      },
    );

    await expect(
      runAgent(
        { config: CONFIG, executionId: EXECUTION_ID },
        { runtimeHost: RUNTIME_HOST, registerExecution: true },
      ),
    ).rejects.toBe(launchError);

    expect(order).toEqual(['finalize', 'release']);
    expect(mocks.finalizeExecution).toHaveBeenCalledWith({
      executionId: EXECUTION_ID,
      terminalStatus: EXECUTION_STATUS.ERROR,
      flowRecord: 'delete',
    });
  });

  it('leaves lifecycle-owned failures to the lifecycle finalizer', async () => {
    const launchError = new Error('flow failed');
    mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
      options.onRun?.();
      throw launchError;
    });

    await expect(
      runAgent(
        { config: CONFIG, executionId: EXECUTION_ID },
        { runtimeHost: RUNTIME_HOST, registerExecution: true },
      ),
    ).rejects.toBe(launchError);

    expect(mocks.finalizeExecution).not.toHaveBeenCalled();
    expect(mocks.releaseOwnedExecutionLeaseBestEffort).toHaveBeenCalledWith(
      EXECUTION_ID,
    );
  });
});
