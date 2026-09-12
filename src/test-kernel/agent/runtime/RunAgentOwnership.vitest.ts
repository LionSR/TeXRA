import { getEventListeners } from 'node:events';

import { it } from '@effect/vitest';
import { Effect } from 'effect';

import { beforeEach, describe, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  validateOwnedRunLease: vi.fn(),
  acquireResumedRunLease: vi.fn(),
  prepareAgentDefinition: vi.fn(),
  readRunEnd: vi.fn(),
  runExists: vi.fn(),
  executeAgent: vi.fn(),
  finalizeRun: vi.fn(),
  registerRun: vi.fn(),
  releaseOwnedRunLease: vi.fn(),
}));

vi.mock('@agent/storage', () => ({
  finalizeRun: (...args: unknown[]) =>
    Effect.tryPromise({
      try: () => mocks.finalizeRun(...args),
      catch: ensureError,
    }),
  registerRun: (...args: unknown[]) =>
    Effect.tryPromise({
      try: () => mocks.registerRun(...args),
      catch: ensureError,
    }),
  getRunRecords: () => ({
    readRunEnd: () => Effect.sync(() => mocks.readRunEnd()),
    exists: () => Effect.sync(() => mocks.runExists()),
  }),
}));

vi.mock('@agent/storage/runLease', () => ({
  acquireResumedRunLease: mocks.acquireResumedRunLease,
  releaseOwnedRunLease: mocks.releaseOwnedRunLease,
  validateOwnedRunLease: mocks.validateOwnedRunLease,
}));

vi.mock('@agent/storage/runLifecycle', async (importActual) => ({
  ...(await importActual<typeof import('@agent/storage/runLifecycle')>()),
  finalizeRun: (...args: unknown[]) =>
    Effect.tryPromise({
      try: () => mocks.finalizeRun(...args),
      catch: ensureError,
    }),
}));

vi.mock('@agent/runtime/AgentLaunchContext', () => ({
  prepareAgentDefinition: (...args: unknown[]) =>
    Effect.sync(() => mocks.prepareAgentDefinition(...args)),
}));

vi.mock('@agent/runtime/executeAgent', async () => {
  const { Effect } = await import('effect');
  return {
    executeAgent: (...args: unknown[]) =>
      Effect.tryPromise({
        try: () => mocks.executeAgent(...args),
        catch: ensureError,
      }),
  };
});

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import type { RunHandle } from '@agent/runtime/RunHandle';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import { runAgent } from '@agent/runtime/runAgent';
import {
  agentErrorPresentation,
  classifyAgentError,
  primaryAgentError,
} from '@common/errors/agentErrorClassification';
import { AgentError } from '@common/errors/agentErrors';
import { attachMissingApiKeyError } from '@common/errors/sdkError/errorMetadata';
import { RUN_OUTCOME, type RunId } from '@shared/schemas';
import { fakeProcessServices } from '@test/support/setupPlatform';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

const RUN_ID = 'a9e70a9e7001' as RunId;
const CONFIG = AgentConfigSchema.parse({
  agent: 'assistant',
  agentCategory: 'toolUse',
  model: 'test-model',
});
const flushArtifacts = vi.fn();
let trackedHandle: RunHandle | undefined;
const trackRun = vi.fn((handle: RunHandle) => {
  trackedHandle = handle;
});
const untrackRun = vi.fn((runId: RunId) => {
  if (trackedHandle?.runId === runId) trackedHandle = undefined;
});
// The real exit choreography over the fake's flushArtifacts and the mocked
// lease verbs, so the existing flush/release assertions keep
// observing the same tree through its one owner.
const SESSION = {
  runs: {
    track: trackRun,
    getHandle: vi.fn((runId) =>
      trackedHandle?.runId === runId ? trackedHandle : undefined,
    ),
    untrack: untrackRun,
    // No competing generation exists in this fixture; the lane is a passthrough.
    launchRun: vi.fn(
      (_runId: RunId, operation: Effect.Effect<unknown, unknown>) => operation,
    ),
  },
  flushArtifacts,
  acquireClaims: () => Effect.succeed(Effect.void),
  graph: { releaseClaims: () => Effect.void },
  releaseClaims: SessionHandle.prototype.releaseClaims,
  settlePublications: vi.fn(async () => {}),
  releaseRunLease: SessionHandle.prototype.releaseRunLease,
} as never;

const EXECUTE_RESULT = {
  category: 'toolUse',
  runId: RUN_ID,
  outcome: 'COMPLETED',
};
const FINALIZE_RESULT = { ok: true };

type RunOptions = Omit<Parameters<typeof runAgent>[1], 'session'> & {
  readonly kind?: 'fresh' | 'resume';
};

/**
 * `runAgent` over the fake host's process services: the suite runs it on the
 * default runtime rather than a process runtime, so the services it requires
 * are provided here.
 */
function launchRun(...args: Parameters<typeof runAgent>) {
  return Effect.provide(runAgent(...args), fakeProcessServices());
}

function launch({ kind = 'resume', ...options }: RunOptions = {}) {
  return Effect.runPromise(
    launchRun(
      { kind, config: CONFIG, runId: RUN_ID },
      { session: SESSION, ...options },
    ),
  );
}

describe('runAgent run ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    trackedHandle = undefined;
    mocks.registerRun.mockResolvedValue(undefined);
    mocks.acquireResumedRunLease.mockResolvedValue('acquired');
    mocks.prepareAgentDefinition.mockImplementation(({ config }) => ({
      config,
    }));
    mocks.readRunEnd.mockReturnValue(null);
    mocks.runExists.mockReturnValue(true);
    mocks.releaseOwnedRunLease.mockResolvedValue(undefined);
    mocks.validateOwnedRunLease.mockResolvedValue(undefined);
    flushArtifacts.mockResolvedValue(undefined);
    mocks.finalizeRun.mockResolvedValue(FINALIZE_RESULT);
    mocks.executeAgent.mockResolvedValue(EXECUTE_RESULT);
  });

  it('cleans up a partially tracked launch when run tracking throws', async () => {
    const signal = new AbortController().signal;
    const removeEventListener = vi.spyOn(signal, 'removeEventListener');
    const trackError = new Error('run tracking failed');
    let partiallyTrackedHandle: RunHandle | undefined;
    trackRun.mockImplementationOnce((handle) => {
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
    expect(untrackRun).toHaveBeenCalledOnce();
    expect(untrackRun).toHaveBeenCalledWith(RUN_ID);
    expect(trackedHandle).toBeUndefined();
    expect(partiallyTrackedHandle).toBeDefined();
    expect(partiallyTrackedHandle?.interrupt()).toBe(false);
  });

  it.effect(
    'does not retain an abort listener when the resumed run is not found',
    () =>
      Effect.gen(function* () {
        const signal = new AbortController().signal;
        mocks.runExists.mockReturnValueOnce(false);
        expect(
          yield* Effect.flip(
            launchRun(
              { kind: 'resume', config: CONFIG, runId: RUN_ID },
              { session: SESSION, launchSignal: signal },
            ),
          ),
        ).toMatchObject({
          message: `Run not found: ${RUN_ID}`,
        });
        expect(getEventListeners(signal, 'abort')).toEqual([]);
      }),
  );

  it('makes a fresh launch interruptible before registration settles', async () => {
    let finishRegistration!: () => void;
    mocks.registerRun.mockImplementationOnce(
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

    expect(mocks.registerRun).toHaveBeenCalledOnce();
    // #9590 obligation 1: registration carries the birth identity and
    // completes before the run — so before any transcript/snapshot fact.
    expect(mocks.registerRun).toHaveBeenCalledWith(
      SESSION,
      RUN_ID,
      CONFIG,
      CONFIG.agent,
      expect.objectContaining({
        identity: { kind: 'agent', agent: CONFIG.agent },
      }),
    );
    expect(mocks.executeAgent).toHaveBeenCalledOnce();
    expect(
      mocks.registerRun.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    ).toBeLessThan(mocks.executeAgent.mock.invocationCallOrder[0] ?? 0);
    expect(mocks.releaseOwnedRunLease).toHaveBeenCalledWith(RUN_ID);
  });

  it('acquires and releases ownership for an existing run', async () => {
    await launch();

    expect(mocks.registerRun).not.toHaveBeenCalled();
    expect(mocks.acquireResumedRunLease).toHaveBeenCalledWith(RUN_ID);
    expect(mocks.releaseOwnedRunLease).toHaveBeenCalledWith(RUN_ID);
  });
  it.effect(
    'registers the resolved category and passes the same definition to run',
    () =>
      Effect.gen(function* () {
        const definition = { config: { ...CONFIG, agentCategory: 'workflow' } };
        mocks.prepareAgentDefinition.mockReturnValueOnce(definition);

        yield* launchRun(
          { kind: 'fresh', config: CONFIG, runId: RUN_ID },
          { session: SESSION },
        );

        expect(mocks.registerRun).toHaveBeenCalledWith(
          SESSION,
          RUN_ID,
          definition.config,
          CONFIG.agent,
          expect.objectContaining({ userFollowUpSupport: 'unsupported' }),
        );
        expect(mocks.executeAgent).toHaveBeenCalledWith(
          definition,
          RUN_ID,
          expect.any(Object),
        );
      }),
  );

  it('persists an early launch error before releasing ownership', async () => {
    const order: string[] = [];
    const launchError = new Error('launch failed');
    mocks.executeAgent.mockRejectedValueOnce(launchError);
    mocks.finalizeRun.mockImplementationOnce(async () => {
      order.push('finalize');
      return FINALIZE_RESULT;
    });
    mocks.releaseOwnedRunLease.mockImplementationOnce(async () => {
      order.push('release');
    });
    await expect(launch({ kind: 'fresh' })).rejects.toBe(launchError);

    expect(order).toEqual(['finalize', 'release']);
    expect(mocks.finalizeRun).toHaveBeenCalledWith(SESSION, {
      runId: RUN_ID,
      outcome: RUN_OUTCOME.FAILED,
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
    expect(mocks.releaseOwnedRunLease).toHaveBeenCalledWith(RUN_ID);
  });

  it('restores a cancelled outcome when resume fails before lifecycle startup', async () => {
    const launchError = new Error('resume launch failed');
    mocks.readRunEnd.mockReturnValueOnce({ outcome: RUN_OUTCOME.CANCELLED });
    mocks.executeAgent.mockRejectedValueOnce(launchError);

    await expect(launch()).rejects.toBe(launchError);

    expect(mocks.finalizeRun).toHaveBeenCalledWith(SESSION, {
      runId: RUN_ID,
      outcome: RUN_OUTCOME.CANCELLED,
    });
    expect(mocks.releaseOwnedRunLease).toHaveBeenCalledWith(RUN_ID);
  });

  it('persists final host artifacts before releasing ownership', async () => {
    const order: string[] = [];
    mocks.executeAgent.mockImplementationOnce(async () => {
      order.push('execute');
      return EXECUTE_RESULT;
    });
    mocks.releaseOwnedRunLease.mockImplementationOnce(async () => {
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

  it('delegates workflow output finalization to the live run lifecycle', async () => {
    const openWorkflowOutput = vi.fn();

    await launch({ kind: 'fresh', openWorkflowOutput });

    expect(mocks.executeAgent).toHaveBeenCalledWith(
      { config: CONFIG },
      RUN_ID,
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
    expect(mocks.releaseOwnedRunLease).not.toHaveBeenCalled();
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
      const artifactError = Object.assign(new Error('artifact writer failed'), {
        code: 'ENOSPC',
      });
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
        runError,
        ...(!lifecycleStarted ? [finalizationError] : []),
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
      expect(mocks.releaseOwnedRunLease).toHaveBeenCalledWith(RUN_ID);
      expect(flushArtifacts).toHaveBeenCalledOnce();
    },
  );
});
