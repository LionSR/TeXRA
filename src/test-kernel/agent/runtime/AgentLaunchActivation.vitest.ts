import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildVars: vi.fn(),
  createTrace: vi.fn(),
  helperCompletion: vi.fn(),
  helperModel: vi.fn(),
  load: vi.fn(),
  retrieveSessionResumeData: vi.fn(),
  resolve: vi.fn(),
  runFlowWithLifecycle: vi.fn(),
}));

vi.mock('@agent/index', () => ({
  isRemoteAgent: () => false,
  resolveAgentForLaunch: mocks.resolve,
}));
vi.mock('@agent/runtime/agentLoad', () => ({
  loadAgentSettingAndPrompts: mocks.load,
}));
vi.mock('@transcript', async (importActual) => ({
  ...(await importActual<typeof import('@transcript')>()),
  createRunTrace: mocks.createTrace,
}));
vi.mock('@agent/prompt/userVars', () => ({ buildUserVars: mocks.buildVars }));
vi.mock('@agent/runtime/SessionResumeRetrieval', () => ({
  retrieveSessionResumeData: mocks.retrieveSessionResumeData,
}));
vi.mock('@agent/runtime/helperModel', async (importActual) => ({
  ...(await importActual<typeof import('@agent/runtime/helperModel')>()),
  helperModel: mocks.helperModel,
  helperCompletion: mocks.helperCompletion,
}));
// Only the regression test below replaces `runFlowWithLifecycle`; every other
// launch in this suite fails during launch-assembly, before the lifecycle, and
// an unconsumed once-implementation falls back to the real one.
vi.mock('@agent/runtime/AgentRunLifecycle', async (importActual) => {
  const actual =
    await importActual<typeof import('@agent/runtime/AgentRunLifecycle')>();
  mocks.runFlowWithLifecycle.mockImplementation(actual.runFlowWithLifecycle);
  return { ...actual, runFlowWithLifecycle: mocks.runFlowWithLifecycle };
});

import { TraceEmitter } from '@agent/trace';
import { prepareAgentDefinition } from '@agent/runtime/AgentLaunchContext';
import type { BoundModel } from '@agent/runtime/run/modelBinding';
import { registerRun } from '@agent/storage/runLifecycle';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  executeAgent,
  resumeToolUseFromResumeData,
} from '@agent/runtime/executeAgent';
import {
  RUN_OUTCOME,
  RUN_PHASE,
  type RunId,
  aggregateId as qualifyAggregateId,
  aggregateTarget,
  type AggregateId,
  AgentCategory,
  type SessionEvent,
} from '@shared/schemas';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import {
  fakeProcessServices,
  type FakeProcessServices,
} from '@test/support/setupPlatform';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
import { eventsOfType, recordSessionEvents } from '../progressTestUtils';

const LAUNCH_FAILURE = new Error('stop after run activation');
const RUN_FAILURE = new Error('run flow failure');
const DESCRIPTION_RUN_ID = 'de5c21' as RunId;

/** The run an aggregate key names: every fact here lives on a run. */
function runOf(key: AggregateId): RunId {
  const target = aggregateTarget(key);
  if (target.kind !== 'run') throw new Error('expected a run aggregate');
  return target.id;
}

const FRESH_RUN_ID = 'f1e501' as RunId;
const MODEL_COMPATIBILITY_KEY = 'OpenAIResponse' as const;

const config = AgentConfigSchema.parse({
  agent: 'chat',
  model: 'gpt55',
  agentCategory: AgentCategory.ToolUse,
});

interface StartedLaunch {
  readonly session: ReturnType<typeof createTestSession>;
  /** The creation fact; absent on a resume, which activates an existing
   *  run and mints no `run.start` (decision 9). */
  readonly start: Extract<SessionEvent, { type: 'run.start' }> | undefined;
  readonly activate: Extract<SessionEvent, { type: 'run.activate' }>;
  readonly end: Extract<SessionEvent, { type: 'run.end' }>;
}

/**
 * Drive a launch that fails after its `run.start` (the reservation commit
 * point): the durable boundary the fold reads. The real trace is attached to
 * the session so the launch's facts reach the hub the way a run's do.
 */
const captureStartedLaunch = Effect.fn(function* (
  run: (
    session: ReturnType<typeof createTestSession>,
  ) => Effect.Effect<unknown, Error, FakeProcessServices>,
  options: {
    /** The launching run, when this launch is a child. */
    readonly parentRunId?: RunId;
    /** A resume activates this already-created run instead of minting one. */
    readonly resumedRunId?: RunId;
  } = {},
) {
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => createTestSession()),
    (session) =>
      Effect.gen(function* () {
        if (options.parentRunId) {
          publishTestRunStart(session, options.parentRunId);
          yield* session.settlePublications();
        }
        if (options.resumedRunId) {
          publishTestRunStart(session, options.resumedRunId, {
            parent: options.parentRunId ?? null,
          });
          yield* session.settlePublications();
        }
        const recordedSession = recordSessionEvents(session);
        const trace = new TraceEmitter();

        mocks.resolve.mockReturnValueOnce({ path: '/agents/chat.yaml' });
        mocks.load.mockReturnValueOnce(
          Effect.succeed([{ agentCategory: AgentCategory.ToolUse }, {}]),
        );
        mocks.createTrace.mockReturnValueOnce({
          trace,
          dispose: vi.fn(),
        });
        mocks.buildVars.mockReturnValueOnce(Effect.fail(LAUNCH_FAILURE));

        if (!options.resumedRunId) {
          yield* registerRun(session, FRESH_RUN_ID, config, 'chat', {
            identity: { kind: 'agent', agent: 'chat' },
            parentRunId: options.parentRunId,
          });
        }
        const error = yield* Effect.flip(
          Effect.provide(run(session), fakeProcessServices()),
        );
        expect(error).toBe(LAUNCH_FAILURE);
        const starts = eventsOfType(
          yield* Effect.promise(() => recordedSession.read()),
          'run.start',
        );
        expect(starts).toHaveLength(options.resumedRunId ? 0 : 1);
        const activations = eventsOfType(
          yield* Effect.promise(() => recordedSession.read()),
          'run.activate',
        );
        expect(activations).toHaveLength(1);
        const ends = eventsOfType(
          yield* Effect.promise(() => recordedSession.read()),
          'run.end',
        );
        expect(ends).toHaveLength(1);
        return {
          session,
          start: starts[0],
          activate: activations[0],
          end: ends[0],
        } satisfies StartedLaunch;
      }),
    (session) => session.dispose(),
  );
});

/**
 * A launch that fails after `run.start` folds to failed, never to a ghost:
 * the existence fact carries the launch facts and the session's owner
 * token, and the same failure path ends the run with its terminal
 * `run.end` row and the FAILED phase.
 */
function expectStartedThenFailed(
  launch: StartedLaunch,
  parentRunId: RunId | undefined,
): void {
  const { start } = launch;
  if (!start) throw new Error('a fresh launch emits run.start');
  expect(start).toMatchObject({
    identity: { kind: 'agent', agent: 'chat' },
    category: AgentCategory.ToolUse,
    isRemote: false,
    // The parent edge is the whole of "is a child": the birth fact carries
    // it, and nothing else spells it.
    parent:
      parentRunId === undefined
        ? null
        : expect.objectContaining({ id: parentRunId }),
    approvalPolicy: launch.session.approvalPolicySnapshotFor(
      runOf(start.aggregateId),
    ),
  });
  expectActivatedThenFailed(launch);
  expect(launch.end.aggregateId).toBe(start.aggregateId);
}

/** Every activation, fresh or resumed, carries the activation metadata the
 *  frozen wire projects and ends on the same failure path. */
function expectActivatedThenFailed(launch: StartedLaunch): void {
  expect(launch.activate).toMatchObject({
    category: AgentCategory.ToolUse,
    isRemote: false,
  });
  expect(launch.end).toMatchObject({
    outcome: RUN_OUTCOME.FAILED,
    aggregateId: launch.activate.aggregateId,
  });
  expect(
    launch.session.runView(runOf(launch.activate.aggregateId))?.status,
  ).toBe(RUN_PHASE.FAILED);
}

describe('native agent launch activation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.effect.each([
    { label: 'child', parentRunId: 'e11000' as RunId },
    { label: 'root', parentRunId: undefined },
  ])(
    'starts a fresh $label launch at the commit point and fails it on the same path',
    ({ parentRunId }) =>
      Effect.gen(function* () {
        // The parent edge picks an `executeAgent` overload, so the call site
        // has to name it rather than let `it.each` widen it.
        const launch = yield* captureStartedLaunch(
          (session) =>
            prepareAgentDefinition({ config, session }).pipe(
              Effect.flatMap((definition) =>
                parentRunId
                  ? executeAgent(definition, FRESH_RUN_ID, {
                      session,
                      parentRunId,
                      modelCompatibilityKey: MODEL_COMPATIBILITY_KEY,
                    })
                  : executeAgent(definition, FRESH_RUN_ID, {
                      session,
                      modelCompatibilityKey: MODEL_COMPATIBILITY_KEY,
                    }),
              ),
            ),
          { parentRunId },
        );

        expectStartedThenFailed(launch, parentRunId);
        expect(launch.activate.aggregateId).toBe(launch.start?.aggregateId);
      }),
  );

  it.effect.each([
    { label: 'child', parentRunId: 'e11001' as RunId },
    { label: 'root', parentRunId: undefined },
  ])(
    'starts a resumed $label launch at the commit point and fails it on the same path',
    ({ parentRunId }) =>
      Effect.gen(function* () {
        const runId = 'ae5010' as RunId;
        const resume = createToolUseResumeData({
          runId,
          agentConfig: config,
          modelCompatibilityKey: MODEL_COMPATIBILITY_KEY,
        });
        mocks.retrieveSessionResumeData.mockReturnValueOnce(
          Effect.succeed(resume),
        );

        const launch = yield* captureStartedLaunch(
          (session) => resumeToolUseFromResumeData(resume, { session }),
          { parentRunId, resumedRunId: runId },
        );

        // A resume activates the run it already has: no second creation
        // fact, one activation on the same failure path.
        expectActivatedThenFailed(launch);
        expect(launch.start).toBeUndefined();
        expect(launch.activate.aggregateId).toBe(
          qualifyAggregateId('run', runId),
        );
      }),
  );

  // Regression: the description join once lived in a generator `finally`,
  // which the Effect driver never resumes after a failed `yield*` — the
  // run-failure path left executeAgent with the write still in flight and
  // auto-supervision interrupted the fiber before it could commit.
  it.effect('joins the session description fiber on the run-failure path', () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<string>();
      const descriptionStarted = yield* Deferred.make<void>();
      mocks.helperModel.mockImplementationOnce(() =>
        Effect.succeed({} as BoundModel),
      );
      mocks.helperCompletion.mockImplementationOnce(() =>
        Deferred.succeed(descriptionStarted, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
        ),
      );
      // Fail the run only once the description fiber is parked on its gate,
      // so both sides settle deterministically.
      mocks.runFlowWithLifecycle.mockImplementationOnce(() =>
        Deferred.await(descriptionStarted).pipe(
          Effect.andThen(Effect.fail(RUN_FAILURE)),
        ),
      );
      mocks.resolve.mockReturnValueOnce({ path: '/agents/chat.yaml' });
      mocks.load.mockReturnValueOnce(
        Effect.succeed([{ agentCategory: AgentCategory.ToolUse }, {}]),
      );
      mocks.createTrace.mockReturnValueOnce({
        trace: new TraceEmitter(),
        dispose: vi.fn(),
      });
      mocks.buildVars.mockResolvedValueOnce({});

      const session = createTestSession();
      yield* Effect.addFinalizer(() => session.dispose());
      const described = AgentConfigSchema.parse({
        agent: 'chat',
        model: 'gpt55',
        agentCategory: AgentCategory.ToolUse,
        instruction: 'Fix grammar.',
      });
      yield* registerRun(session, DESCRIPTION_RUN_ID, described, 'chat', {
        identity: { kind: 'agent', agent: 'chat' },
      });
      const failure = yield* Effect.forkChild(
        Effect.flip(
          prepareAgentDefinition({ config: described, session }).pipe(
            Effect.flatMap((definition) =>
              executeAgent(definition, DESCRIPTION_RUN_ID, { session }),
            ),
            Effect.provide(fakeProcessServices()),
          ),
        ),
      );

      yield* Deferred.await(descriptionStarted);
      yield* Deferred.succeed(gate, 'Fixing grammar in the introduction');
      expect(yield* Fiber.join(failure)).toBe(RUN_FAILURE);
      const view = yield* session.readView([DESCRIPTION_RUN_ID]);
      expect(view.runs.get(DESCRIPTION_RUN_ID)?.description).toBe(
        'Fixing grammar in the introduction',
      );
    }),
  );
});
