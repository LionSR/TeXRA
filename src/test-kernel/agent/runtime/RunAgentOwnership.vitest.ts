import { it } from '@effect/vitest';
import { Cause, Effect, Exit, Fiber } from 'effect';

import { beforeEach, describe, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  acquireClaims: vi.fn(),
  prepareAgentDefinition: vi.fn(),
  runActive: vi.fn(() => false),
  executeAgent: vi.fn(),
  finalizeRun: vi.fn(),
  releaseClaims: vi.fn(),
}));

vi.mock('@agent/storage/runLifecycle', async (importActual) => ({
  ...(await importActual<typeof import('@agent/storage/runLifecycle')>()),
  registerRun: (...args: unknown[]) =>
    Effect.tryPromise({
      try: () => mocks.registerRun(...args),
      catch: ensureError,
    }),
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

import { ModelError } from '@texra-ai/llm';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { RunHandle } from '@agent/runtime/RunHandle';
import type { RunRegistry } from '@agent/runtime/runRegistry';
import { runAgent } from '@agent/runtime/runAgent';
import {
  agentErrorPresentation,
  classifyAgentError,
  primaryAgentError,
} from '@common/errors/agentErrorClassification';
import { AgentError, RouteUnavailable } from '@common/errors/agentErrors';
import { aggregateId as qualifyAggregateId, type RunId } from '@shared/schemas';
import { fakeProcessServices } from '@test/support/setupPlatform';
import { testRunRegistry } from '@test/support/runHandleFixtures';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

const RUN_ID = 'a9e70a9e7001' as RunId;
// The persisted lineage a resume reads after tracking its launch handle.
// Empty unless a case seeds this run's `run.start` parent.
const persistedRuns = new Map<RunId, { readonly parentId: RunId }>();
const CONFIG = AgentConfigSchema.parse({
  agent: 'assistant',
  model: 'test-model',
});
let trackedHandle: RunHandle | undefined;
const trackRun = vi.fn((handle: RunHandle) => {
  trackedHandle = handle;
});
const untrackRun = vi.fn((runId: RunId) => {
  if (trackedHandle?.runId === runId) trackedHandle = undefined;
});
// The real exit choreography over the mocked claim verbs, so the existing flush/release assertions keep
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
  view: { read: () => Effect.succeed({ runs: persistedRuns }) },
  log: {
    // A runAgent launch is fresh: the log holds no row of its run yet.
    rows: () => Effect.succeed([]),
    records: () => Effect.succeed([]),
    // The launch's hold on the run's claim: its release also reports to
    // `mocks.releaseClaims`, which the release-order cases observe.
    hold: (runId: RunId) => {
      const id = qualifyAggregateId('run', runId);
      return Effect.asVoid(
        Effect.acquireRelease(
          mocks.acquireClaims(id) as Effect.Effect<Effect.Effect<void>>,
          (release) =>
            release.pipe(
              Effect.andThen(
                Effect.suspend(
                  () => mocks.releaseClaims(id) as Effect.Effect<void>,
                ),
              ),
            ),
        ),
      );
    },
  },
} as never;

const EXECUTE_RESULT = {
  runId: RUN_ID,
  outcome: 'COMPLETED',
};

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

/** Launches on a real registry, the session's own runs replaced by it. */
function launchOn(runs: RunRegistry) {
  return launchRun(
    { config: CONFIG, runId: RUN_ID },
    { session: { ...(SESSION as object), runs } as never },
  );
}

describe('runAgent run ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    trackedHandle = undefined;
    persistedRuns.clear();
    mocks.acquireClaims.mockReturnValue(Effect.succeed(Effect.void));
    mocks.releaseClaims.mockReturnValue(Effect.void);
    mocks.prepareAgentDefinition.mockImplementation(({ config }) => ({
      config,
    }));
    mocks.executeAgent.mockResolvedValue(EXECUTE_RESULT);
  });

  it.effect('refuses a second launch while the first is still running', () =>
    Effect.gen(function* () {
      // A real registry: the first launch's admission is its fiber on the
      // run registry, so the duplicate is refused against it wherever the
      // first launch has got to — here, mid-run.
      const runs = testRunRegistry();
      mocks.executeAgent.mockImplementationOnce(
        () => new Promise<never>(() => {}),
      );
      const first = yield* Effect.forkChild(launchOn(runs), {
        startImmediately: true,
      });
      expect(yield* Effect.flip(launchOn(runs))).toMatchObject({
        message: `Run is already running: ${RUN_ID}`,
      });
      // The first launch's stop is its fiber's interruption.
      expect(runs.interrupt(RUN_ID)).toBe(true);
      const exit = yield* Fiber.await(first);
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(
        true,
      );
    }),
  );

  it.effect('registers and releases an explicitly identified fresh run', () =>
    Effect.gen(function* () {
      yield* launch();

      // #9590 obligation 1: the run is born with its birth identity, in the
      // opening `executeAgent` commits — so before any transcript fact.
      expect(mocks.executeAgent).toHaveBeenCalledOnce();
      expect(mocks.executeAgent).toHaveBeenCalledWith(
        { config: CONFIG },
        RUN_ID,
        expect.objectContaining({
          registration: expect.objectContaining({
            identity: { kind: 'agent', agent: CONFIG.agent },
          }),
        }),
      );
      // The birth's claim is let go once the launch is done.
      expect(mocks.releaseClaims).toHaveBeenCalledWith(
        qualifyAggregateId('run', RUN_ID),
      );
    }),
  );

  it.effect(
    'registers the resolved config and passes the same definition to run',
    () =>
      Effect.gen(function* () {
        const definition = { config: { ...CONFIG, agent: 'resolved' } };
        mocks.prepareAgentDefinition.mockReturnValueOnce(definition);

        yield* launchRun(
          { config: CONFIG, runId: RUN_ID },
          { session: SESSION },
        );

        expect(mocks.executeAgent).toHaveBeenCalledWith(
          definition,
          RUN_ID,
          expect.objectContaining({
            registration: expect.objectContaining({
              identity: { kind: 'agent', agent: 'resolved' },
            }),
          }),
        );
      }),
  );

  it.effect(
    'fails an early launch as itself, writing no ending, and lets the claim go',
    () =>
      Effect.gen(function* () {
        const launchError = new Error('launch failed');
        mocks.executeAgent.mockRejectedValueOnce(launchError);
        expect(yield* Effect.flip(launch())).toBe(launchError);

        // A run is born with its opening, so a launch failing before it
        // leaves no run to end.
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

      yield* launch({
        beforeRunEnd: () =>
          Effect.sync(() => {
            order.push('artifacts');
          }),
      });

      expect(order).toEqual(['execute', 'artifacts', 'release']);
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

  it.effect.each(['missing-api-key', 'context-window', 'unexpected'] as const)(
    'preserves the %s run failure and cleanup diagnostics before releasing ownership',
    (kind) =>
      Effect.gen(function* () {
        // Model access's missing key, and the package's overflow verdict.
        const primaryError: Error = {
          'missing-api-key': new RouteUnavailable({
            reason: 'missing-api-key',
            message: 'run failed',
          }),
          'context-window': new ModelError({
            kind: 'context-overflow',
            message: 'maximum context length is 128000',
          }),
          unexpected: new Error('run failed'),
        }[kind];
        const runError = new AgentError(primaryError.message, {
          cause: primaryError,
        });
        const artifactError = Object.assign(
          new Error('artifact writer failed'),
          {
            code: 'ENOSPC',
          },
        );
        mocks.executeAgent.mockRejectedValueOnce(runError);

        const failure = yield* Effect.flip(
          launch({
            beforeRunEnd: () => Effect.fail(artifactError),
          }),
        );

        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors).toEqual([
          runError,
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
        // A failed host hook never changes ownership: the launch still
        // releases the claim.
        expect(mocks.releaseClaims).toHaveBeenCalledWith(
          qualifyAggregateId('run', RUN_ID),
        );
      }),
  );
});
