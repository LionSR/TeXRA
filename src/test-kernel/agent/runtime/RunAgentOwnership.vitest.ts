import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  abandonOwnedExecutionLease: vi.fn(),
  runWithOwnedExecutionLease: vi.fn(
    async (_executionId: ExecutionId, operation: () => Promise<unknown>) =>
      operation(),
  ),
  acquireResumedExecutionLease: vi.fn(),
  executeAgent: vi.fn(),
  finalizeExecution: vi.fn(),
  markOwnedExecutionLeaseUndurable: vi.fn(),
  registerExecution: vi.fn(),
  completeOwnedExecutionLease: vi.fn(),
}));

vi.mock('@agent/storage', () => ({
  abandonOwnedExecutionLease: mocks.abandonOwnedExecutionLease,
  runWithOwnedExecutionLease: mocks.runWithOwnedExecutionLease,
  acquireResumedExecutionLease: mocks.acquireResumedExecutionLease,
  completeOwnedExecutionLease: mocks.completeOwnedExecutionLease,
  finalizeExecution: mocks.finalizeExecution,
  registerExecution: mocks.registerExecution,
}));

vi.mock('@agent/storage/executionLease', () => ({
  markOwnedExecutionLeaseUndurable: mocks.markOwnedExecutionLeaseUndurable,
  runWithOwnedExecutionLease: mocks.runWithOwnedExecutionLease,
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
const flushArtifacts = vi.fn();
const SESSION = { flushArtifacts } as never;

describe('runAgent execution ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.registerExecution.mockResolvedValue(undefined);
    mocks.acquireResumedExecutionLease.mockResolvedValue('acquired');
    mocks.completeOwnedExecutionLease.mockResolvedValue(undefined);
    flushArtifacts.mockResolvedValue(undefined);
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
      { runtimeHost: RUNTIME_HOST, session: SESSION, registerExecution: true },
    );

    expect(mocks.registerExecution).toHaveBeenCalledOnce();
    expect(mocks.executeAgent).toHaveBeenCalledOnce();
    expect(mocks.completeOwnedExecutionLease).toHaveBeenCalledWith(
      EXECUTION_ID,
    );
  });

  it('acquires and releases ownership for an existing execution', async () => {
    await runAgent(
      { config: CONFIG, executionId: EXECUTION_ID },
      { runtimeHost: RUNTIME_HOST, session: SESSION },
    );

    expect(mocks.registerExecution).not.toHaveBeenCalled();
    expect(mocks.acquireResumedExecutionLease).toHaveBeenCalledWith(
      EXECUTION_ID,
    );
    expect(mocks.completeOwnedExecutionLease).toHaveBeenCalledWith(
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
    mocks.completeOwnedExecutionLease.mockImplementationOnce(async () => {
      order.push('release');
    });
    await expect(
      runAgent(
        { config: CONFIG, executionId: EXECUTION_ID },
        {
          runtimeHost: RUNTIME_HOST,
          session: SESSION,
          registerExecution: true,
        },
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
        {
          runtimeHost: RUNTIME_HOST,
          session: SESSION,
          registerExecution: true,
        },
      ),
    ).rejects.toBe(launchError);

    expect(mocks.finalizeExecution).not.toHaveBeenCalled();
    expect(mocks.completeOwnedExecutionLease).toHaveBeenCalledWith(
      EXECUTION_ID,
    );
  });

  it('marks an early terminal-persistence failure undurable', async () => {
    const launchError = new Error('launch failed');
    const persistenceError = new Error('terminal metadata failed');
    mocks.executeAgent.mockRejectedValueOnce(launchError);
    mocks.finalizeExecution.mockResolvedValueOnce({
      status: 'failed',
      stage: 'terminal-status',
      terminalStatusPersisted: false,
      error: persistenceError,
    });

    const failure = await runAgent(
      { config: CONFIG, executionId: EXECUTION_ID },
      {
        runtimeHost: RUNTIME_HOST,
        session: SESSION,
        registerExecution: true,
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(mocks.markOwnedExecutionLeaseUndurable).toHaveBeenCalledWith(
      EXECUTION_ID,
    );
  });

  it('persists final host artifacts before releasing ownership', async () => {
    const order: string[] = [];
    mocks.executeAgent.mockImplementationOnce(async () => {
      order.push('execute');
      return {
        category: 'toolUse',
        executionId: EXECUTION_ID,
        streamId: EXECUTION_ID,
        outcome: 'COMPLETED',
      };
    });
    mocks.completeOwnedExecutionLease.mockImplementationOnce(async () => {
      order.push('release');
    });
    flushArtifacts.mockImplementationOnce(async () => {
      order.push('session-artifacts');
    });

    await runAgent(
      { config: CONFIG, executionId: EXECUTION_ID },
      {
        runtimeHost: RUNTIME_HOST,
        session: SESSION,
        registerExecution: true,
        beforeLeaseRelease: async () => {
          order.push('artifacts');
        },
      },
    );

    expect(order).toEqual([
      'execute',
      'artifacts',
      'session-artifacts',
      'release',
    ]);
  });

  it('preserves run and final-artifact failures before releasing ownership', async () => {
    const runError = new Error('run failed');
    const artifactError = new Error('transcript flush failed');
    mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
      options.onRun?.();
      throw runError;
    });

    const failure = await runAgent(
      { config: CONFIG, executionId: EXECUTION_ID },
      {
        runtimeHost: RUNTIME_HOST,
        session: SESSION,
        registerExecution: true,
        beforeLeaseRelease: async () => {
          throw artifactError;
        },
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      runError,
      artifactError,
    ]);
    expect(mocks.completeOwnedExecutionLease).not.toHaveBeenCalled();
    expect(mocks.abandonOwnedExecutionLease).toHaveBeenCalledWith(EXECUTION_ID);
    expect(flushArtifacts).toHaveBeenCalledOnce();
  });
});
