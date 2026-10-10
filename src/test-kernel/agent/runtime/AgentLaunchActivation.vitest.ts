import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildVars: vi.fn(),
  helperCall: vi.fn(),
  retrieveSessionResumeData: vi.fn(),
  resolve: vi.fn(),
  runWithLifecycle: vi.fn(),
}));

vi.mock('@agent/index/agentRegistry', async (importActual) => ({
  ...(await importActual<typeof import('@agent/index/agentRegistry')>()),
  resolveAgentForLaunch: mocks.resolve,
  settledCatalog: Effect.void,
}));
vi.mock('@agent/prompt/templateInputs', () => ({
  buildTemplateInputs: mocks.buildVars,
}));
vi.mock('@agent/runtime/SessionResumeRetrieval', () => ({
  retrieveSessionResumeData: mocks.retrieveSessionResumeData,
}));
vi.mock('@agent/runtime/helperModel', async (importActual) => ({
  ...(await importActual<typeof import('@agent/runtime/helperModel')>()),
  helperCall: mocks.helperCall,
}));
// Only the regression test below replaces `runWithLifecycle`; every other
// launch in this suite fails during launch-assembly, before the lifecycle, and
// an unconsumed once-implementation falls back to the real one.
vi.mock('@agent/runtime/AgentRunLifecycle', async (importActual) => {
  const actual =
    await importActual<typeof import('@agent/runtime/AgentRunLifecycle')>();
  mocks.runWithLifecycle.mockImplementation(actual.runWithLifecycle);
  return { ...actual, runWithLifecycle: mocks.runWithLifecycle };
});

import {
  prepareAgentDefinition,
  type AgentLaunchContext,
} from '@agent/runtime/AgentLaunchContext';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  executeAgent,
  resumeToolUseFromResumeData,
} from '@agent/runtime/executeAgent';
import { runWithLaunchGuard } from '@agent/runtime/runLaunchGuard';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { RunId } from '@shared/schemas';
import { closeSessionOf } from '@test/support/sessionEnd';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import {
  fakeProcessServices,
  type FakeProcessServices,
} from '@test/support/setupPlatform';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
import { recordSessionEvents } from '../progressTestUtils';

const LAUNCH_FAILURE = new Error('stop before the run opens');
const RUN_FAILURE = new Error('run flow failure');
const DESCRIPTION_RUN_ID = 'de5c21' as RunId;

const FRESH_RUN_ID = 'f1e501' as RunId;

const config = AgentConfigSchema.parse({
  agent: 'chat',
  model: 'openai/gpt-5.5-2026-04-23',
});

/**
 * Drive a launch that fails before its run opens (its template inputs
 * fail to render) and answer the rows it left: a run is born with its
 * opening, and a resume activates with it, so a launch that never opened
 * writes nothing, and its failure is the launch's own.
 */
const rowsOfFailedLaunch = Effect.fn(function* (
  run: (
    session: SessionHandle,
  ) => Effect.Effect<unknown, Error, FakeProcessServices>,
  options: {
    /** The launching run, when this launch is a child. */
    readonly parentRunId?: RunId;
    /** A resume of this already-created run. */
    readonly resumedRunId?: RunId;
  } = {},
) {
  return yield* Effect.acquireUseRelease(
    createTestSession(),
    (session) =>
      Effect.gen(function* () {
        if (options.parentRunId) {
          publishTestRunStart(session, options.parentRunId);
          yield* session.log.settled;
        }
        if (options.resumedRunId) {
          publishTestRunStart(session, options.resumedRunId, {
            parent: options.parentRunId ?? null,
          });
          yield* session.log.settled;
        }
        const recordedSession = recordSessionEvents(session);

        // A fresh launch fails rendering its opening; a resume, which renders
        // none, resolving its agent.
        if (options.resumedRunId)
          mocks.resolve.mockReturnValueOnce(Effect.fail(LAUNCH_FAILURE));
        else {
          mocks.resolve.mockReturnValueOnce(
            Effect.succeed({
              path: '/agents/chat.yaml',
              persona: { prompt: '', tools: [], temperature: 1 },
              task: null,
            }),
          );
          mocks.buildVars.mockReturnValueOnce(Effect.fail(LAUNCH_FAILURE));
        }
        const error = yield* Effect.flip(
          Effect.provide(run(session), fakeProcessServices()),
        );
        expect(error).toBe(LAUNCH_FAILURE);
        yield* session.log.settled;
        return (yield* Effect.promise(() => recordedSession.read())).filter(
          (event) =>
            event.type === 'run.start' ||
            event.type === 'run.activate' ||
            event.type === 'run.end',
        );
      }),
    (session) => closeSessionOf(session),
  );
});

describe('native agent launch activation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.effect.each([
    { label: 'child', parentRunId: 'e11000' as RunId },
    { label: 'root', parentRunId: undefined },
  ])(
    'a fresh $label launch that fails before its opening leaves no run',
    ({ parentRunId }) =>
      Effect.gen(function* () {
        const rows = yield* rowsOfFailedLaunch(
          (session) =>
            prepareAgentDefinition({ config, session }).pipe(
              Effect.flatMap((definition) =>
                // The launch terminal `runAgent` runs a fresh run under.
                runWithLaunchGuard(
                  session,
                  FRESH_RUN_ID,
                  executeAgent(definition, FRESH_RUN_ID, {
                    session,
                    ...(parentRunId !== undefined && { parentRunId }),
                    registration: {
                      identity: { kind: 'agent', agent: 'chat' },
                      ...(parentRunId !== undefined && { parentRunId }),
                    },
                  }),
                  {},
                ),
              ),
            ),
          { parentRunId },
        );
        expect(rows).toEqual([]);
      }),
  );

  it.effect.each([
    { label: 'child', parentRunId: 'e11001' as RunId },
    { label: 'root', parentRunId: undefined },
  ])(
    'a resumed $label launch that fails before its activation leaves the run as it was',
    ({ parentRunId }) =>
      Effect.gen(function* () {
        const runId = 'ae5010' as RunId;
        const resume = createToolUseResumeData({
          runId,
          agentConfig: config,
        });
        mocks.retrieveSessionResumeData.mockReturnValueOnce(
          Effect.succeed(resume),
        );
        const rows = yield* rowsOfFailedLaunch(
          (session) => resumeToolUseFromResumeData(resume, { session }),
          { parentRunId, resumedRunId: runId },
        );
        expect(rows).toEqual([]);
      }),
  );

  // Regression: the description join once lived in a generator `finally`,
  // which the Effect driver never resumes after a failed `yield*` — the
  // run-failure path left executeAgent with the write still in flight and
  // auto-supervision interrupted the fiber before it could commit.
  it.effect(
    'joins the session description fiber on the run-failure path',
    () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<string>();
        const descriptionStarted = yield* Deferred.make<void>();
        mocks.helperCall.mockImplementationOnce(() =>
          Deferred.succeed(descriptionStarted, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
          ),
        );
        // The run is born (its registration alone stands in for the
        // opening), then fails once the description fiber is parked on its
        // gate, so both sides settle deterministically.
        mocks.runWithLifecycle.mockImplementationOnce(
          (ctx: AgentLaunchContext) =>
            Effect.gen(function* () {
              const { registration, entered } = ctx.entry;
              if (registration === null)
                return yield* Effect.die('a fresh run');
              const cell = yield* ctx.session.runHistory.open(ctx.runId, {
                registration,
              });
              yield* cell.append(
                [],
                Effect.succeed({ rows: [], committed: entered }),
              );
              yield* Deferred.await(descriptionStarted);
              return yield* Effect.fail(RUN_FAILURE);
            }),
        );
        mocks.resolve.mockReturnValueOnce(
          Effect.succeed({
            path: '/agents/chat.yaml',
            persona: { prompt: '', tools: [], temperature: 1 },
            task: null,
          }),
        );
        mocks.buildVars.mockReturnValueOnce(
          Effect.succeed({
            inputs: {},
            catalog: [],
            activated: [],
            attachedMemoryMisses: [],
          }),
        );

        const session = yield* createTestSession();
        yield* Effect.addFinalizer(() => closeSessionOf(session));
        const described = AgentConfigSchema.parse({
          agent: 'chat',
          model: 'openai/gpt-5.5-2026-04-23',
          instruction: 'Fix grammar.',
        });
        const failure = yield* Effect.forkChild(
          Effect.flip(
            prepareAgentDefinition({ config: described, session }).pipe(
              Effect.flatMap((definition) =>
                executeAgent(definition, DESCRIPTION_RUN_ID, {
                  session,
                  registration: { identity: { kind: 'agent', agent: 'chat' } },
                }),
              ),
              Effect.provide(fakeProcessServices()),
            ),
          ),
        );

        yield* Deferred.await(descriptionStarted);
        yield* Deferred.succeed(gate, 'Fixing grammar in the introduction');
        expect(yield* Fiber.join(failure)).toBe(RUN_FAILURE);
        const view = yield* session.view.read([DESCRIPTION_RUN_ID]);
        expect(view.runs.get(DESCRIPTION_RUN_ID)?.description).toBe(
          'Fixing grammar in the introduction',
        );
      }),
    // This case parks on a Deferred that a *forked* fiber completes, so it is
    // the first casualty of a contended machine: under heavy parallel load the
    // fork's own scheduling has exceeded the suite's 10s kernel timeout while
    // the assertions below were still sound. Give this one case room; the
    // assertion is unchanged, so a genuinely broken join still fails here.
    { timeout: 30_000 },
  );
});
