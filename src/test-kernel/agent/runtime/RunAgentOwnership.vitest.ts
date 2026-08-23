import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  validateOwnedExecutionLease: vi.fn(),
  acquireResumedExecutionLease: vi.fn(),
  clearTerminalExecutionState: vi.fn(),
  executeAgent: vi.fn(),
  finalizeExecution: vi.fn(),
  registerExecution: vi.fn(),
  releaseOwnedExecutionLease: vi.fn(),
}));

vi.mock('@agent/storage', () => ({
  finalizeExecution: mocks.finalizeExecution,
  registerExecution: mocks.registerExecution,
}));

vi.mock('@agent/storage/executionLease', () => ({
  acquireResumedExecutionLease: mocks.acquireResumedExecutionLease,
  releaseOwnedExecutionLease: mocks.releaseOwnedExecutionLease,
  validateOwnedExecutionLease: mocks.validateOwnedExecutionLease,
}));

vi.mock('@agent/storage/executionLifecycle', () => ({
  clearTerminalExecutionState: mocks.clearTerminalExecutionState,
  finalizeExecution: mocks.finalizeExecution,
}));

vi.mock('@agent/runtime/executeAgent', () => ({
  executeAgent: mocks.executeAgent,
}));

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import type { AgentExecutionHandle } from '@agent/runtime/ExecutionHandle';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import { runAgent } from '@agent/runtime/runAgent';
import { getStreamTabId } from '@agent/runtime/streamTab';
import { RUN_OUTCOME, type ExecutionId } from '@shared/schemas';

const EXECUTION_ID = 'run-agent-owner' as ExecutionId;
const CONFIG = AgentConfigSchema.parse({
  agent: 'assistant',
  agentCategory: 'toolUse',
  model: 'test-model',
});
const flushArtifacts = vi.fn();
let trackedHandle: AgentExecutionHandle | undefined;
// The real exit choreography over the fake's flushArtifacts and the mocked
// lease verbs, so the existing flush/release assertions keep
// observing the same tree through its one owner.
const SESSION = {
  executions: {
    track: vi.fn((handle) => {
      trackedHandle = handle;
    }),
    getHandle: vi.fn((executionId) =>
      trackedHandle?.executionId === executionId ? trackedHandle : undefined,
    ),
    untrack: vi.fn((executionId) => {
      if (trackedHandle?.executionId === executionId) trackedHandle = undefined;
    }),
    // No competing generation exists in this fixture; the lane is a passthrough.
    launchExecution: vi.fn((_executionId: ExecutionId, start: () => unknown) =>
      start(),
    ),
  },
  flushArtifacts,
  releaseExecutionLease: SessionHandle.prototype.releaseExecutionLease,
} as never;

const EXECUTE_RESULT = {
  category: 'toolUse',
  executionId: EXECUTION_ID,
  streamId: EXECUTION_ID,
  outcome: 'COMPLETED',
};
const FINALIZE_RESULT = {
  status: 'durable',
  terminalStatusPersisted: true,
  flowRecord: 'deleted',
};

type RunOptions = Omit<Parameters<typeof runAgent>[1], 'session'> & {
  readonly kind?: 'fresh' | 'resume';
};

function launch({ kind = 'resume', ...options }: RunOptions = {}): ReturnType<
  typeof runAgent
> {
  return runAgent(
    { kind, config: CONFIG, executionId: EXECUTION_ID },
    { session: SESSION, ...options },
  );
}

describe('runAgent execution ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    trackedHandle = undefined;
    mocks.registerExecution.mockResolvedValue(undefined);
    mocks.acquireResumedExecutionLease.mockResolvedValue('acquired');
    mocks.clearTerminalExecutionState.mockResolvedValue({
      previousOutcome: undefined,
      streamId: 'assistant#run-agent-owner',
    });
    mocks.releaseOwnedExecutionLease.mockResolvedValue(undefined);
    mocks.validateOwnedExecutionLease.mockResolvedValue(undefined);
    flushArtifacts.mockResolvedValue(undefined);
    mocks.finalizeExecution.mockResolvedValue(FINALIZE_RESULT);
    mocks.executeAgent.mockResolvedValue(EXECUTE_RESULT);
  });

  it('makes a fresh launch interruptible before registration settles', async () => {
    let finishRegistration!: () => void;
    mocks.registerExecution.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRegistration = resolve;
        }),
    );

    const run = launch({ kind: 'fresh' });
    expect(trackedHandle?.interrupt()).toBe(true);
    finishRegistration();
    await run;

    const executeOptions = mocks.executeAgent.mock.calls[0]?.[2];
    expect(executeOptions?.launchSignal?.aborted).toBe(true);
  });

  it('registers and releases an explicitly identified fresh run', async () => {
    await launch({ kind: 'fresh' });

    expect(mocks.registerExecution).toHaveBeenCalledOnce();
    // #9590 obligation 1: registration carries the birth stream identity and
    // completes before the run — so before any transcript/snapshot fact.
    expect(mocks.registerExecution).toHaveBeenCalledWith(
      EXECUTION_ID,
      CONFIG,
      CONFIG.agent,
      expect.objectContaining({
        streamId: getStreamTabId(CONFIG.agent, {
          executionId: EXECUTION_ID,
        }),
      }),
    );
    expect(mocks.executeAgent).toHaveBeenCalledOnce();
    expect(
      mocks.registerExecution.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    ).toBeLessThan(mocks.executeAgent.mock.invocationCallOrder[0] ?? 0);
    expect(mocks.releaseOwnedExecutionLease).toHaveBeenCalledWith(EXECUTION_ID);
  });

  it('acquires and releases ownership for an existing execution', async () => {
    await launch();

    expect(mocks.registerExecution).not.toHaveBeenCalled();
    expect(mocks.acquireResumedExecutionLease).toHaveBeenCalledWith(
      EXECUTION_ID,
    );
    expect(mocks.releaseOwnedExecutionLease).toHaveBeenCalledWith(EXECUTION_ID);
  });

  // A workflow resume reuses the execution record, so the previous run's
  // terminal outcome is still on disk and would be projected onto every result
  // envelope this run writes (`applyExecutionOutcome`) until it finalizes.
  it('clears the previous run terminal facts before a resumed run executes', async () => {
    const order: string[] = [];
    mocks.clearTerminalExecutionState.mockImplementationOnce(async () => {
      order.push('clear');
      return {
        previousOutcome: undefined,
        streamId: 'assistant#run-agent-owner',
      };
    });
    mocks.executeAgent.mockImplementationOnce(async () => {
      order.push('execute');
      return EXECUTE_RESULT;
    });

    await launch();

    expect(mocks.clearTerminalExecutionState).toHaveBeenCalledWith(
      EXECUTION_ID,
    );
    expect(mocks.executeAgent).toHaveBeenCalledWith(
      CONFIG,
      EXECUTION_ID,
      expect.objectContaining({
        streamTabIdOverride: 'assistant#run-agent-owner',
      }),
    );
    expect(order).toEqual(['clear', 'execute']);
  });

  it('leaves a freshly registered run without a terminal-fact clear', async () => {
    await launch({ kind: 'fresh' });

    expect(mocks.clearTerminalExecutionState).not.toHaveBeenCalled();
  });

  it('persists an early launch error before releasing ownership', async () => {
    const order: string[] = [];
    const launchError = new Error('launch failed');
    mocks.executeAgent.mockRejectedValueOnce(launchError);
    mocks.finalizeExecution.mockImplementationOnce(async () => {
      order.push('finalize');
      return FINALIZE_RESULT;
    });
    mocks.releaseOwnedExecutionLease.mockImplementationOnce(async () => {
      order.push('release');
    });
    await expect(launch({ kind: 'fresh' })).rejects.toBe(launchError);

    expect(order).toEqual(['finalize', 'release']);
    expect(mocks.finalizeExecution).toHaveBeenCalledWith({
      executionId: EXECUTION_ID,
      outcome: RUN_OUTCOME.FAILED,
      flowRecord: 'delete',
    });
  });

  it('leaves lifecycle-owned failures to the lifecycle finalizer', async () => {
    const launchError = new Error('flow failed');
    mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
      options.onRun?.();
      throw launchError;
    });

    await expect(launch({ kind: 'fresh' })).rejects.toBe(launchError);

    expect(mocks.finalizeExecution).not.toHaveBeenCalled();
    expect(mocks.releaseOwnedExecutionLease).toHaveBeenCalledWith(EXECUTION_ID);
  });

  it('restores a cancelled outcome when resume fails before lifecycle startup', async () => {
    const launchError = new Error('resume launch failed');
    mocks.clearTerminalExecutionState.mockResolvedValueOnce({
      previousOutcome: RUN_OUTCOME.CANCELLED,
      streamId: 'assistant#run-agent-owner',
    });
    mocks.executeAgent.mockRejectedValueOnce(launchError);

    await expect(launch()).rejects.toBe(launchError);

    expect(mocks.finalizeExecution).toHaveBeenCalledWith({
      executionId: EXECUTION_ID,
      outcome: RUN_OUTCOME.CANCELLED,
      flowRecord: 'preserve',
    });
    expect(mocks.releaseOwnedExecutionLease).toHaveBeenCalledWith(EXECUTION_ID);
  });

  it('persists final host artifacts before releasing ownership', async () => {
    const order: string[] = [];
    mocks.executeAgent.mockImplementationOnce(async () => {
      order.push('execute');
      return EXECUTE_RESULT;
    });
    mocks.releaseOwnedExecutionLease.mockImplementationOnce(async () => {
      order.push('release');
    });
    flushArtifacts.mockImplementationOnce(async () => {
      order.push('session-artifacts');
    });

    await launch({
      kind: 'fresh',
      beforeLeaseRelease: async () => {
        order.push('artifacts');
      },
    });

    expect(order).toEqual([
      'execute',
      'artifacts',
      'session-artifacts',
      'release',
    ]);
  });

  it('delegates workflow output finalization to the live execution lifecycle', async () => {
    const openWorkflowOutput = vi.fn();

    await launch({ kind: 'fresh', openWorkflowOutput });

    expect(mocks.executeAgent).toHaveBeenCalledWith(
      CONFIG,
      EXECUTION_ID,
      expect.objectContaining({ openWorkflowOutput }),
    );
    expect(openWorkflowOutput).not.toHaveBeenCalled();
  });

  it('does not drain artifacts again after the host disposed of ownership', async () => {
    const order: string[] = [];
    mocks.executeAgent.mockImplementationOnce(async () => {
      order.push('execute');
      return EXECUTE_RESULT;
    });
    await launch({
      kind: 'fresh',
      beforeLeaseRelease: async () => {
        order.push('host-artifacts-and-release');
        return true;
      },
    });

    expect(order).toEqual(['execute', 'host-artifacts-and-release']);
    expect(flushArtifacts).not.toHaveBeenCalled();
    expect(mocks.releaseOwnedExecutionLease).not.toHaveBeenCalled();
  });

  it('preserves run and final-artifact failures before releasing ownership', async () => {
    const runError = new Error('run failed');
    const artifactError = new Error('transcript flush failed');
    mocks.executeAgent.mockImplementationOnce(async (_config, _id, options) => {
      options.onRun?.();
      throw runError;
    });

    const failure = await launch({
      kind: 'fresh',
      beforeLeaseRelease: async () => {
        throw artifactError;
      },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      runError,
      artifactError,
    ]);
    // A failed host hook never changes ownership: the one drain still runs
    // and releases the lease.
    expect(mocks.releaseOwnedExecutionLease).toHaveBeenCalledWith(EXECUTION_ID);
    expect(flushArtifacts).toHaveBeenCalledOnce();
  });
});
