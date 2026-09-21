import { it } from '@effect/vitest';
import { Cause, Deferred, Effect, Exit, Fiber } from 'effect';

import { beforeEach, describe, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  acquireClaims: vi.fn(),
  prepareAgentDefinition: vi.fn(),
  readRunEnd: vi.fn(),
  runExists: vi.fn(),
  runActive: vi.fn(() => false),
  executeAgent: vi.fn(),
  finalizeRun: vi.fn(),
  registerRun: vi.fn(),
  releaseClaims: vi.fn(),
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
    readRunEnd: () =>
      Effect.tryPromise({
        try: async () => mocks.readRunEnd(),
        catch: ensureError,
      }),
    exists: () => Effect.sync(() => mocks.runExists()),
  }),
}));

vi.mock('@agent/storage/runLifecycle', async (importActual) => ({
  ...(await importActual<typeof import('@agent/storage/runLifecycle')>()),
  finalizeRun: (...args: unknown[]) =>
    Effect.tryPromise({
      try: () => mocks.finalizeRun(...args),
      catch: ensureError,
    }),
}));

vi.mock('@agent/runtime/AgentLaunchContext', async (importActual) => ({
  failIfLaunchStopped: (
    await importActual<typeof import('@agent/runtime/AgentLaunchContext')>()
  ).failIfLaunchStopped,
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
import { RunHandle } from '@agent/runtime/RunHandle';
import { createSessionApprovals } from '@agent/runtime/runApprovalQueue';
import { RunRegistry } from '@agent/runtime/runRegistry';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import { runAgent } from '@agent/runtime/runAgent';
import {
  agentErrorPresentation,
  classifyAgentError,
  primaryAgentError,
} from '@common/errors/agentErrorClassification';
import { AgentError } from '@common/errors/agentErrors';
import { attachMissingApiKeyError } from '@common/errors/sdkError/errorMetadata';
import {
  aggregateId as qualifyAggregateId,
  RUN_OUTCOME,
  type RunId,
} from '@shared/schemas';
import { testParkedFibers } from '@test/support/runHandleFixtures';
import { fakeProcessServices } from '@test/support/setupPlatform';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

const RUN_ID = 'a9e70a9e7001' as RunId;
const PARENT_RUN_ID = 'a9e70a9e7002' as RunId;
// The persisted lineage a resume reads after tracking its launch handle.
// Empty unless a case seeds this run's `run.start` parent.
const persistedRuns = new Map<RunId, { readonly parentId: RunId }>();
const CONFIG = AgentConfigSchema.parse({
  agent: 'assistant',
  agentCategory: 'toolUse',
  model: 'test-model',
});
const settlePublications = vi.fn(
  (_runId?: RunId): Effect.Effect<void, Error> => Effect.void,
);
let trackedHandle: RunHandle | undefined;
const trackRun = vi.fn((handle: RunHandle) => {
  trackedHandle = handle;
});
const untrackRun = vi.fn((runId: RunId) => {
  if (trackedHandle?.runId === runId) trackedHandle = undefined;
});
// The real exit choreography over the fake's settlePublications and the mocked
// claim verbs, so the existing flush/release assertions keep
// observing the same tree through its one owner.
const SESSION = {
  runs: {
    track: trackRun,
    getHandle: vi.fn((runId) =>
      trackedHandle?.runId === runId ? trackedHandle : undefined,
    ),
    untrack: untrackRun,
    // No generation is live unless a case says so.
    isActiveOrResuming: () => mocks.runActive(),
    // This fixture never parks a run at WAITING; the cases that do build a
    // real registry of their own.
    isParked: () => false,
    // The registry's local application of a durable detach, over the one
    // handle this fixture tracks.
    detachChildren: vi.fn((_parent: RunId, children: readonly RunId[]) => {
      if (trackedHandle && children.includes(trackedHandle.runId))
        trackedHandle.detach();
    }),
    // No competing generation exists in this fixture; the lane is a passthrough.
    launchRun: vi.fn(
      (_runId: RunId, operation: Effect.Effect<unknown, unknown>) => operation,
    ),
    // No parent is detaching this run, so its release waits on nothing.
    throughDetach: () => Effect.void,
  },
  readView: () => Effect.succeed({ runs: persistedRuns }),
  acquireClaims: (...args: unknown[]) => mocks.acquireClaims(...args),
  graph: {
    releaseClaims: (...args: unknown[]) => mocks.releaseClaims(...args),
  },
  releaseClaims: SessionHandle.prototype.releaseClaims,
  settlePublications,
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
  return launchRun(
    { kind, config: CONFIG, runId: RUN_ID },
    { session: SESSION, ...options },
  );
}

describe('runAgent run ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    trackedHandle = undefined;
    persistedRuns.clear();
    mocks.registerRun.mockResolvedValue(undefined);
    mocks.acquireClaims.mockReturnValue(Effect.succeed(Effect.void));
    mocks.releaseClaims.mockReturnValue(Effect.void);
    mocks.prepareAgentDefinition.mockImplementation(({ config }) => ({
      config,
    }));
    mocks.readRunEnd.mockReturnValue(null);
    mocks.runExists.mockReturnValue(true);
    settlePublications.mockReturnValue(Effect.void);
    mocks.finalizeRun.mockResolvedValue(FINALIZE_RESULT);
    mocks.executeAgent.mockResolvedValue(EXECUTE_RESULT);
  });

  it.effect(
    'cleans up a partially tracked launch when run tracking throws',
    () =>
      Effect.gen(function* () {
        const trackError = new Error('run tracking failed');
        let partiallyTrackedHandle: RunHandle | undefined;
        trackRun.mockImplementationOnce((handle) => {
          trackedHandle = handle;
          partiallyTrackedHandle = handle;
          throw trackError;
        });

        const exit = yield* Effect.exit(launch({ kind: 'fresh' }));
        expect(Exit.isFailure(exit)).toBe(true);
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(
          trackError,
        );

        expect(untrackRun).toHaveBeenCalledOnce();
        expect(untrackRun).toHaveBeenCalledWith(RUN_ID);
        expect(trackedHandle).toBeUndefined();
        expect(partiallyTrackedHandle).toBeDefined();
        expect(partiallyTrackedHandle?.interrupt()).toBe(false);
      }),
  );

  it.effect(
    'refuses a resume of a run this session already runs before any snapshot',
    () =>
      Effect.gen(function* () {
        mocks.runActive.mockReturnValueOnce(true);
        expect(
          yield* Effect.flip(
            launchRun(
              { kind: 'resume', config: CONFIG, runId: RUN_ID },
              { session: SESSION },
            ),
          ),
        ).toMatchObject({ message: `Run is already running: ${RUN_ID}` });
        expect(mocks.readRunEnd).not.toHaveBeenCalled();
        expect(trackRun).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'refuses a second resume while the first has only tracked its launch handle',
    () =>
      Effect.gen(function* () {
        let finishRead!: (value: null) => void;
        mocks.readRunEnd.mockImplementationOnce(
          () =>
            new Promise<null>((resolve) => {
              finishRead = resolve;
            }),
        );
        const first = yield* Effect.forkChild(launch(), {
          startImmediately: true,
        });
        expect(yield* Effect.flip(launch())).toMatchObject({
          message: `Run is already running: ${RUN_ID}`,
        });
        const firstHandler = trackedHandle;
        expect(firstHandler?.interrupt()).toBe(true);
        finishRead(null);
        expect(yield* Effect.flip(Fiber.join(first))).toMatchObject({
          name: 'AbortError',
        });
      }),
  );

  it.effect(
    'refuses a resume of a missing run and untracks its launch handle',
    () =>
      Effect.gen(function* () {
        mocks.runExists.mockReturnValueOnce(false);
        expect(
          yield* Effect.flip(
            launchRun(
              { kind: 'resume', config: CONFIG, runId: RUN_ID },
              { session: SESSION },
            ),
          ),
        ).toMatchObject({
          message: `Run not found: ${RUN_ID}`,
        });
        expect(trackRun).toHaveBeenCalledOnce();
        expect(untrackRun).toHaveBeenCalledWith(RUN_ID);
        expect(trackedHandle).toBeUndefined();
      }),
  );

  it.effect(
    'admits a resumed child under the parent its `run.start` names',
    () =>
      Effect.gen(function* () {
        persistedRuns.set(RUN_ID, { parentId: PARENT_RUN_ID });
        // What the registry does to a child of a parent whose stop has begun
        // (`assertAdmitsChild`): a resume is refused where any other child
        // launch is, instead of installing its parent after that stop ended.
        const refusal = new Error(
          `Cannot launch child run ${RUN_ID} under run ${PARENT_RUN_ID} while that run is stopping.`,
        );
        let admittedParent: RunId | null | undefined;
        trackRun.mockImplementation((handle) => {
          if (handle.parent === PARENT_RUN_ID) {
            admittedParent = handle.parent;
            throw refusal;
          }
          trackedHandle = handle;
        });

        const exit = yield* Effect.exit(launch());

        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(refusal);
        // The edge is on the handle before launch preparation begins, so the
        // parent's stop reaches this child instead of missing it.
        expect(admittedParent).toBe(PARENT_RUN_ID);
        expect(mocks.executeAgent).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'takes a detach another host committed while the launch prepared',
    () =>
      Effect.gen(function* () {
        persistedRuns.set(RUN_ID, { parentId: PARENT_RUN_ID });
        // The foreign `run.detach` folds before this launch owns the run; a
        // foreign row never reaches the handle this session tracked.
        mocks.acquireClaims.mockImplementationOnce(() =>
          Effect.sync(() => {
            persistedRuns.delete(RUN_ID);
            return Effect.void;
          }),
        );
        let launched: RunHandle | undefined;
        trackRun.mockImplementation((handle) => {
          trackedHandle = handle;
          launched = handle;
        });

        yield* launch();

        expect(launched?.parent).toBeNull();
      }),
  );

  it.effect('stops a resumed launch killed during its lineage read', () =>
    Effect.gen(function* () {
      let finishRead!: (value: null) => void;
      mocks.readRunEnd.mockImplementationOnce(
        () =>
          new Promise<null>((resolve) => {
            finishRead = resolve;
          }),
      );

      const fiber = yield* Effect.forkChild(launch(), {
        startImmediately: true,
      });
      expect(trackedHandle?.interrupt()).toBe(true);
      finishRead(null);
      expect(yield* Effect.flip(Fiber.join(fiber))).toMatchObject({
        name: 'AbortError',
      });
      expect(mocks.executeAgent).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    'stops a resume through a kill of its parked predecessor, which still tears down',
    () =>
      Effect.gen(function* () {
        // A real registry: the kill goes through `runs.kill`, the parked
        // handle carries the launch's stop, and the parked fiber's
        // termination must still run before the stop settles.
        const runs = new RunRegistry({
          runView: () => undefined,
          commit: () => Effect.void,
          approvals: createSessionApprovals(),
          finalizeRun: ((input: { readonly outcome: string }) =>
            Effect.succeed({ ok: true, outcome: input.outcome })) as never,
          acquireRunClaim: () => Effect.succeed(Effect.void),
          parked: testParkedFibers(),
        });
        const parked = new RunHandle(
          {
            runId: RUN_ID,
            identity: { kind: 'agent', agent: CONFIG.agent },
            category: 'toolUse',
          },
          null,
        );
        runs.track(parked);
        let tornDown = false;
        const parkStopped = yield* Deferred.make<void>();
        yield* runs.park(
          parked,
          parkStopped,
          Effect.sync(() => {
            tornDown = true;
          }),
        );
        let finishRead!: (value: null) => void;
        mocks.readRunEnd.mockImplementationOnce(
          () =>
            new Promise<null>((resolve) => {
              finishRead = resolve;
            }),
        );

        const fiber = yield* Effect.forkChild(
          launchRun(
            { kind: 'resume', config: CONFIG, runId: RUN_ID },
            { session: { ...(SESSION as object), runs } as never },
          ),
          { startImmediately: true },
        );
        const stop = runs.kill(RUN_ID);
        yield* stop.settlement;
        finishRead(null);
        const exit = yield* Effect.exit(Fiber.join(fiber));

        expect({
          accepted: stop.accepted(),
          tornDown,
          launch: Exit.isFailure(exit) && Cause.squash(exit.cause),
        }).toMatchObject({
          accepted: true,
          tornDown: true,
          launch: { name: 'AbortError' },
        });
      }),
  );

  it.effect(
    'makes a fresh launch interruptible before registration settles',
    () =>
      Effect.gen(function* () {
        let finishRegistration!: () => void;
        mocks.registerRun.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finishRegistration = resolve;
            }),
        );

        const fiber = yield* Effect.forkChild(launch({ kind: 'fresh' }), {
          startImmediately: true,
        });
        expect(trackedHandle?.interrupt()).toBe(true);
        finishRegistration();
        yield* Fiber.join(fiber);

        const executeOptions = mocks.executeAgent.mock.calls[0]?.[2];
        expect(Deferred.isDoneUnsafe(executeOptions?.launchStopped)).toBe(true);
      }),
  );

  it.effect('registers and releases an explicitly identified fresh run', () =>
    Effect.gen(function* () {
      yield* launch({ kind: 'fresh' });

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
        mocks.registerRun.mock.invocationCallOrder[0] ??
          Number.POSITIVE_INFINITY,
      ).toBeLessThan(mocks.executeAgent.mock.invocationCallOrder[0] ?? 0);
      expect(mocks.releaseClaims).toHaveBeenCalledWith(
        qualifyAggregateId('run', RUN_ID),
      );
    }),
  );

  it.effect('acquires and releases ownership for an existing run', () =>
    Effect.gen(function* () {
      yield* launch();

      expect(mocks.registerRun).not.toHaveBeenCalled();
      expect(mocks.acquireClaims).toHaveBeenCalledWith(
        qualifyAggregateId('run', RUN_ID),
      );
      expect(mocks.releaseClaims).toHaveBeenCalledWith(
        qualifyAggregateId('run', RUN_ID),
      );
    }),
  );
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

  it.effect('persists an early launch error before releasing ownership', () =>
    Effect.gen(function* () {
      const order: string[] = [];
      const launchError = new Error('launch failed');
      mocks.executeAgent.mockRejectedValueOnce(launchError);
      mocks.finalizeRun.mockImplementationOnce(async () => {
        order.push('finalize');
        return FINALIZE_RESULT;
      });
      mocks.releaseClaims.mockImplementationOnce(() =>
        Effect.sync(() => {
          order.push('release');
        }),
      );
      expect(yield* Effect.flip(launch({ kind: 'fresh' }))).toBe(launchError);

      expect(order).toEqual(['finalize', 'release']);
      expect(mocks.finalizeRun).toHaveBeenCalledWith(SESSION, {
        runId: RUN_ID,
        outcome: RUN_OUTCOME.FAILED,
      });
    }),
  );

  it.effect('leaves lifecycle-owned failures to the lifecycle finalizer', () =>
    Effect.gen(function* () {
      const launchError = new Error('flow failed');
      mocks.executeAgent.mockImplementationOnce(
        async (_config, _id, options) => {
          Effect.runSync(options.onRun?.() ?? Effect.void);
          throw launchError;
        },
      );

      expect(yield* Effect.flip(launch({ kind: 'fresh' }))).toBe(launchError);

      expect(mocks.finalizeRun).not.toHaveBeenCalled();
      expect(mocks.releaseClaims).toHaveBeenCalledWith(
        qualifyAggregateId('run', RUN_ID),
      );
    }),
  );

  it.effect(
    'restores a cancelled outcome when resume fails before lifecycle startup',
    () =>
      Effect.gen(function* () {
        const launchError = new Error('resume launch failed');
        // Read twice: the snapshot, then the revalidation before it is restored.
        mocks.readRunEnd.mockReturnValue({
          outcome: RUN_OUTCOME.CANCELLED,
        });
        mocks.executeAgent.mockRejectedValueOnce(launchError);

        expect(yield* Effect.flip(launch())).toBe(launchError);

        expect(mocks.finalizeRun).toHaveBeenCalledWith(SESSION, {
          runId: RUN_ID,
          outcome: RUN_OUTCOME.CANCELLED,
        });
        expect(mocks.releaseClaims).toHaveBeenCalledWith(
          qualifyAggregateId('run', RUN_ID),
        );
      }),
  );

  it.effect('persists final host artifacts before releasing ownership', () =>
    Effect.gen(function* () {
      const order: string[] = [];
      mocks.executeAgent.mockImplementationOnce(async () => {
        order.push('execute');
        return EXECUTE_RESULT;
      });
      mocks.releaseClaims.mockImplementationOnce(() =>
        Effect.sync(() => {
          order.push('release');
        }),
      );
      settlePublications.mockImplementationOnce(() =>
        Effect.sync(() => {
          order.push('session-artifacts');
        }),
      );

      yield* launch({
        kind: 'fresh',
        beforeLeaseRelease: () =>
          Effect.sync(() => {
            order.push('artifacts');
          }),
      });

      expect(order).toEqual([
        'execute',
        'artifacts',
        'session-artifacts',
        'release',
      ]);
    }),
  );

  it.effect(
    'delegates workflow output finalization to the live run lifecycle',
    () =>
      Effect.gen(function* () {
        const openWorkflowOutput = vi.fn();

        yield* launch({ kind: 'fresh', openWorkflowOutput });

        expect(mocks.executeAgent).toHaveBeenCalledWith(
          { config: CONFIG },
          RUN_ID,
          expect.objectContaining({ openWorkflowOutput }),
        );
        expect(openWorkflowOutput).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'does not drain artifacts again after the host disposed of ownership',
    () =>
      Effect.gen(function* () {
        const order: string[] = [];
        mocks.executeAgent.mockImplementationOnce(async () => {
          order.push('execute');
          return EXECUTE_RESULT;
        });
        yield* launch({
          kind: 'fresh',
          beforeLeaseRelease: () =>
            Effect.sync(() => {
              order.push('host-artifacts-and-release');
              return true;
            }),
        });

        expect(order).toEqual(['execute', 'host-artifacts-and-release']);
        expect(settlePublications).not.toHaveBeenCalled();
        expect(mocks.releaseClaims).not.toHaveBeenCalled();
      }),
  );

  it.effect.each(['missing-api-key', 'context-window', 'unexpected'] as const)(
    'preserves the %s run failure and cleanup diagnostics before releasing ownership',
    (kind) =>
      Effect.gen(function* () {
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
          new Error('artifact writer failed'),
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
            if (lifecycleStarted)
              await Effect.runPromise(options.onRun?.() ?? Effect.void);
            throw runError;
          },
        );

        const failure = yield* Effect.flip(
          launch({
            kind: 'fresh',
            beforeLeaseRelease: () => Effect.fail(artifactError),
          }),
        );

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
        // and releases the claim.
        expect(mocks.releaseClaims).toHaveBeenCalledWith(
          qualifyAggregateId('run', RUN_ID),
        );
        expect(settlePublications).toHaveBeenCalledWith(RUN_ID);
      }),
  );
});
