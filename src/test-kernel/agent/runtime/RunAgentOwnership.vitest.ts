import { it } from '@effect/vitest';
import { Cause, Effect, Exit, Fiber } from 'effect';

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
    resumeToolUseFromResumeData: () => Effect.die('Unexpected resume'),
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
  type AggregateId,
  RUN_OUTCOME,
  type RunId,
} from '@shared/schemas';
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
const sessionRuns = {
  track: trackRun,
  getHandle: vi.fn((runId) =>
    trackedHandle?.runId === runId ? trackedHandle : undefined,
  ),
  untrack: untrackRun,
  // No generation is live unless a case says so.
  isLive: () => mocks.runActive(),
  // This fixture never parks a run at WAITING; the cases that do build a
  // real registry of their own.
  // The registry's local application of a durable detach, over the one
  // handle this fixture tracks.
  detachChildren: vi.fn((_parent: RunId, children: readonly RunId[]) => {
    if (trackedHandle && children.includes(trackedHandle.runId))
      trackedHandle.parentState.current = null;
  }),
  // No competing generation exists in this fixture; the lane is a passthrough.
  launchRun: vi.fn(
    (_runId: RunId, operation: Effect.Effect<unknown, unknown>) => operation,
  ),
};
const SESSION = {
  runs: sessionRuns,
  readView: () => Effect.succeed({ runs: persistedRuns }),
  // The launch's hold on the run's claim: the release it hands back also
  // reports to `mocks.releaseClaims`, which the release-order cases observe.
  acquireClaims: (id: AggregateId) =>
    (mocks.acquireClaims(id) as Effect.Effect<Effect.Effect<void>>).pipe(
      Effect.map((release) =>
        release.pipe(
          Effect.andThen(Effect.suspend(() => mocks.releaseClaims(id))),
        ),
      ),
    ),
  holdRunClaim: SessionHandle.prototype.holdRunClaim,
  borrowRunClaim: SessionHandle.prototype.borrowRunClaim,
  settlePublications,
  commitRunEnd: SessionHandle.prototype.commitRunEnd,
} as never;

const EXECUTE_RESULT = {
  category: 'toolUse',
  runId: RUN_ID,
  outcome: 'COMPLETED',
};
const FINALIZE_RESULT = { ok: true };

type RunOptions = Omit<Parameters<typeof runAgent>[1], 'session'>;

/**
 * `runAgent` over the fake host's process services: the suite runs it on the
 * default runtime rather than a process runtime, so the services it requires
 * are provided here.
 */
function launchRun(...args: Parameters<typeof runAgent>) {
  return Effect.provide(runAgent(...args), fakeProcessServices());
}

function launch(options: RunOptions = {}) {
  return launchRun(
    { config: CONFIG, runId: RUN_ID },
    { session: SESSION, ...options },
  );
}

/** A real registry whose lane, liveness and stop the launch answers to. */
function realRunRegistry(): RunRegistry {
  return new RunRegistry({
    runView: () => undefined,
    commit: () => Effect.void,
    approvals: createSessionApprovals(),
    finalizeRun: ((input: { readonly outcome: string }) =>
      Effect.succeed({ ok: true, outcome: input.outcome })) as never,
    holdRunClaim: () => Effect.void,
    borrowRunClaim: () => Effect.void,
  });
}

/** Launches on a real registry, the session's own runs replaced by it. */
function launchOn(runs: RunRegistry) {
  return launchRun(
    { config: CONFIG, runId: RUN_ID },
    { session: { ...(SESSION as object), runs } as never },
  );
}

/** Runs the launch's own `onRun` lifecycle hook, as the mocked host would. */
function runOnRun(options: {
  readonly onRun?: () => Effect.Effect<void>;
}): Promise<void> {
  return Effect.runPromise(options.onRun?.() ?? Effect.void);
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
    'refuses a second launch while the first is still registering',
    () =>
      Effect.gen(function* () {
        // A real registry: the first launch's admission is its fiber on the
        // roster, so the duplicate is refused against it wherever the first
        // launch has got to — here, mid-registration.
        const runs = realRunRegistry();
        let finishRegistration!: () => void;
        mocks.registerRun.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finishRegistration = resolve;
            }),
        );
        const first = yield* Effect.forkChild(launchOn(runs), {
          startImmediately: true,
        });
        expect(yield* Effect.flip(launchOn(runs))).toMatchObject({
          message: `Run is already running: ${RUN_ID}`,
        });
        // The first launch's stop is its fiber's interruption.
        expect(runs.interrupt(RUN_ID)).toBe(true);
        finishRegistration();
        const exit = yield* Fiber.await(first);
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(
          true,
        );
      }),
  );

  it.effect(
    'makes a fresh launch interruptible before registration settles',
    () =>
      Effect.gen(function* () {
        const runs = realRunRegistry();
        let finishRegistration!: () => void;
        mocks.registerRun.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finishRegistration = resolve;
            }),
        );

        const fiber = yield* Effect.forkChild(
          launchRun(
            { config: CONFIG, runId: RUN_ID },
            { session: { ...(SESSION as object), runs } as never },
          ),
          { startImmediately: true },
        );
        expect(runs.interrupt(RUN_ID)).toBe(true);
        finishRegistration();
        const exit = yield* Fiber.await(fiber);

        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(
          true,
        );
        expect(mocks.executeAgent).not.toHaveBeenCalled();
      }),
  );

  it.effect('registers and releases an explicitly identified fresh run', () =>
    Effect.gen(function* () {
      yield* launch();

      expect(mocks.registerRun).toHaveBeenCalledOnce();
      // #9590 obligation 1: registration carries the birth identity and
      // completes before the run — so before any transcript/snapshot fact.
      expect(mocks.registerRun).toHaveBeenCalledWith(
        SESSION,
        RUN_ID,
        CONFIG,
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

  it.effect(
    'registers the resolved category and passes the same definition to run',
    () =>
      Effect.gen(function* () {
        const definition = { config: { ...CONFIG, agentCategory: 'workflow' } };
        mocks.prepareAgentDefinition.mockReturnValueOnce(definition);

        yield* launchRun(
          { config: CONFIG, runId: RUN_ID },
          { session: SESSION },
        );

        expect(mocks.registerRun).toHaveBeenCalledWith(
          SESSION,
          RUN_ID,
          definition.config,
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
      expect(yield* Effect.flip(launch())).toBe(launchError);

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

      expect(yield* Effect.flip(launch())).toBe(launchError);

      expect(mocks.finalizeRun).not.toHaveBeenCalled();
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
        beforeRunEnd: () =>
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
        const publishWorkflowOutput = vi.fn();

        yield* launch({ publishWorkflowOutput });

        expect(mocks.executeAgent).toHaveBeenCalledWith(
          { config: CONFIG },
          RUN_ID,
          expect.objectContaining({ publishWorkflowOutput }),
        );
        expect(publishWorkflowOutput).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'does not drain artifacts again after the host committed the run end',
    () =>
      Effect.gen(function* () {
        const order: string[] = [];
        mocks.executeAgent.mockImplementationOnce(async () => {
          order.push('execute');
          return EXECUTE_RESULT;
        });
        yield* launch({
          beforeRunEnd: () =>
            Effect.sync(() => {
              order.push('host-artifacts-and-release');
              return true;
            }),
        });

        expect(order).toEqual(['execute', 'host-artifacts-and-release']);
        expect(settlePublications).not.toHaveBeenCalled();
        // The host committed the run's ending; the claim is still the
        // launch's hold, released once as its scope closes.
        expect(mocks.releaseClaims).toHaveBeenCalledExactlyOnceWith(
          qualifyAggregateId('run', RUN_ID),
        );
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
            if (lifecycleStarted) await runOnRun(options);
            throw runError;
          },
        );

        const failure = yield* Effect.flip(
          launch({
            beforeRunEnd: () => Effect.fail(artifactError),
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
        // A failed host hook never changes ownership: the run's ending still
        // commits, and the launch's scope still releases the claim.
        expect(mocks.releaseClaims).toHaveBeenCalledWith(
          qualifyAggregateId('run', RUN_ID),
        );
        expect(settlePublications).toHaveBeenCalledWith(RUN_ID);
      }),
  );
});
