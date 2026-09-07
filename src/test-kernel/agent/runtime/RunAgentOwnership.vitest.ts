import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  validateOwnedExecutionLease: vi.fn(),
  acquireResumedExecutionLease: vi.fn(),
  clearTerminalExecutionState: vi.fn(),
  executeAgent: vi.fn(),
  finalizeRun: vi.fn(),
  registerExecution: vi.fn(),
  releaseOwnedExecutionLease: vi.fn(),
}));

vi.mock('@agent/storage', () => ({
  finalizeRun: mocks.finalizeRun,
  registerExecution: mocks.registerExecution,
}));

vi.mock('@agent/storage/executionLease', () => ({
  acquireResumedExecutionLease: mocks.acquireResumedExecutionLease,
  releaseOwnedExecutionLease: mocks.releaseOwnedExecutionLease,
  validateOwnedExecutionLease: mocks.validateOwnedExecutionLease,
}));

vi.mock('@agent/storage/executionLifecycle', () => ({
  clearTerminalExecutionState: mocks.clearTerminalExecutionState,
  finalizeRun: mocks.finalizeRun,
}));

vi.mock('@agent/runtime/executeAgent', () => ({
  executeAgent: mocks.executeAgent,
}));

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import type { AgentExecutionHandle } from '@agent/runtime/ExecutionHandle';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import { runAgent } from '@agent/runtime/runAgent';
import { getStreamTabId } from '@agent/runtime/streamTab';
import {
  agentErrorPresentation,
  classifyAgentError,
  primaryAgentError,
} from '@common/errors/agentErrorClassification';
import { AgentError } from '@common/errors/agentErrors';
import { attachMissingApiKeyError } from '@common/errors/sdkError/errorMetadata';
import { RUN_OUTCOME, type ExecutionId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

const EXECUTION_ID = 'run-agent-owner' as ExecutionId;
const CONFIG = AgentConfigSchema.parse({
  agent: 'assistant',
  agentCategory: 'toolUse',
  model: 'test-model',
});
const flushArtifacts = vi.fn();
let trackedHandle: AgentExecutionHandle | undefined;
const trackExecution = vi.fn((handle: AgentExecutionHandle) => {
  trackedHandle = handle;
});
const untrackExecution = vi.fn((executionId: ExecutionId) => {
  if (trackedHandle?.executionId === executionId) trackedHandle = undefined;
});
// The real exit choreography over the fake's flushArtifacts and the mocked
// lease verbs, so the existing flush/release assertions keep
// observing the same tree through its one owner.
const SESSION = {
  executions: {
    track: trackExecution,
    getHandle: vi.fn((executionId) =>
      trackedHandle?.executionId === executionId ? trackedHandle : undefined,
    ),
    untrack: untrackExecution,
    // No competing generation exists in this fixture; the lane is a passthrough.
    launchExecution: vi.fn((_executionId: ExecutionId, start: () => unknown) =>
      start(),
    ),
  },
  flushArtifacts,
  settlePublications: vi.fn(async () => {}),
  releaseExecutionLease: SessionHandle.prototype.releaseExecutionLease,
} as never;

const EXECUTE_RESULT = {
  category: 'toolUse',
  executionId: EXECUTION_ID,
  streamId: EXECUTION_ID,
  outcome: 'COMPLETED',
};
const FINALIZE_RESULT = { ok: true };

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
    mocks.finalizeRun.mockResolvedValue(FINALIZE_RESULT);
    mocks.executeAgent.mockResolvedValue(EXECUTE_RESULT);
  });

  it('cleans up a partially tracked launch when execution tracking throws', async () => {
    const signal = new AbortController().signal;
    const removeEventListener = vi.spyOn(signal, 'removeEventListener');
    const trackError = new Error('execution tracking failed');
    let partiallyTrackedHandle: AgentExecutionHandle | undefined;
    trackExecution.mockImplementationOnce((handle) => {
      trackedHandle = handle;
      partiallyTrackedHandle = handle;
      throw trackError;
    });

    await expect(launch({ kind: 'fresh', launchSignal: signal })).rejects.toBe(
      trackError,
    );

    expect(removeEventListener).toHaveBeenCalledWith(
      'abort',
      expect.any(Function),
    );
    expect(untrackExecution).toHaveBeenCalledOnce();
    expect(untrackExecution).toHaveBeenCalledWith(EXECUTION_ID);
    expect(trackedHandle).toBeUndefined();
    expect(partiallyTrackedHandle).toBeDefined();
    expect(partiallyTrackedHandle?.interrupt()).toBe(false);
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
  // envelope this run writes (`readResultMeta`) until it finalizes.
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
    mocks.finalizeRun.mockImplementationOnce(async () => {
      order.push('finalize');
      return FINALIZE_RESULT;
    });
    mocks.releaseOwnedExecutionLease.mockImplementationOnce(async () => {
      order.push('release');
    });
    await expect(launch({ kind: 'fresh' })).rejects.toBe(launchError);

    expect(order).toEqual(['finalize', 'release']);
    expect(mocks.finalizeRun).toHaveBeenCalledWith({
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

    expect(mocks.finalizeRun).not.toHaveBeenCalled();
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

    expect(mocks.finalizeRun).toHaveBeenCalledWith({
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

  it.each(['missing-api-key', 'context-window', 'unexpected'] as const)(
    'preserves the %s run failure and cleanup diagnostics before releasing ownership',
    async (kind) => {
      const primaryError = new Error(
        kind === 'context-window'
          ? 'maximum context length is 128000'
          : 'run failed',
      );
      if (kind === 'missing-api-key') attachMissingApiKeyError(primaryError);
      const runError = new AgentError(primaryError.message, {
        cause: primaryError,
      });
      const artifactError = Object.assign(
        new Error('transcript flush failed'),
        {
          code: 'ENOSPC',
        },
      );
      const finalizationError = new Error('terminal status write failed');
      const lifecycleStarted = kind !== 'context-window';
      if (!lifecycleStarted) {
        mocks.finalizeRun.mockResolvedValueOnce({
          ok: false,
          error: finalizationError,
        });
      }
      mocks.executeAgent.mockImplementationOnce(
        async (_config, _id, options) => {
          if (lifecycleStarted) await options.onRun?.();
          throw runError;
        },
      );

      const failure = await launch({
        kind: 'fresh',
        beforeLeaseRelease: async () => {
          throw artifactError;
        },
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([
        lifecycleStarted
          ? runError
          : expect.objectContaining({ errors: [runError, finalizationError] }),
        artifactError,
      ]);
      expect(classifyAgentError(failure)).toBe(kind);
      const primary = primaryAgentError(failure);
      expect(primary).toBe(runError);
      expect(
        agentErrorPresentation({
          kind: classifyAgentError(primary),
          message: toErrorMessage(primary),
        }),
      ).toMatchObject(
        kind === 'missing-api-key'
          ? { type: 'instruction', payload: { key: 'missingApiKey' } }
          : { type: 'error', payload: { message: primaryError.message } },
      );
      // A failed host hook never changes ownership: the one drain still runs
      // and releases the lease.
      expect(mocks.releaseOwnedExecutionLease).toHaveBeenCalledWith(
        EXECUTION_ID,
      );
      expect(flushArtifacts).toHaveBeenCalledOnce();
    },
  );
});
