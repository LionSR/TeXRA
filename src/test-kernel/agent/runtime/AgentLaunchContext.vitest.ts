import { it } from '@effect/vitest';
import { Cause, Effect, Exit, Layer } from 'effect';
import { assert, beforeEach, describe, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  buildVars: vi.fn(),
}));

vi.mock('@agent/index', () => ({
  getCatalogLoadFailure: () => undefined,
  getCustomAgentScanIssues: () => [],
  refresh: () => Effect.void,
  settledCatalog: Effect.void,
  resolveAgentForLaunch: mocks.resolve,
}));
vi.mock('@agent/prompt/templateInputs', () => ({
  buildTemplateInputs: mocks.buildVars,
}));

import { registerRun } from '@agent/storage/runLifecycle';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  buildAgentLaunchContext as buildAgentLaunchContextEffect,
  prepareAgentDefinition,
} from '@agent/runtime/AgentLaunchContext';
import { runWithLaunchGuard } from '@agent/runtime/runLaunchGuard';
import { TraceEmitter } from '@agent/trace';
import { hasErrorPresentationClaimed } from '@common/errors/sdkError/errorMetadata';
import {
  LanguageModel,
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
} from '@platform/languageModel';
import {
  RUN_OUTCOME,
  RUN_PHASE,
  AgentCategory,
  type RunId,
} from '@shared/schemas';
import { closeSessionOf } from '@test/support/sessionEnd';
import { noopTrace } from '@test/support/noopTrace';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { fakeProcessServices } from '@test/support/setupPlatform';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { setGoalSessionAutoApproval } from '@tools/goal';

import { createRecordingHost, recordSessionEvents } from '../progressTestUtils';

const buildAgentLaunchContext = (
  input: Omit<
    Parameters<typeof buildAgentLaunchContextEffect>[0],
    'definition'
  > &
    Parameters<typeof prepareAgentDefinition>[0],
) =>
  prepareAgentDefinition(input).pipe(
    Effect.flatMap((definition) =>
      buildAgentLaunchContextEffect({ ...input, definition }),
    ),
    // The launch's scope stands in for the run's: closing it here retires
    // the trace the way the end of a run does.
    Effect.scoped,
    Effect.provide(fakeProcessServices()),
  );

/** Lets the queued banner replay run (queueMicrotask + a Promise.resolve hop). */
const settle = Effect.promise(
  () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
);

const EXECUTION_ID = 'a00101' as RunId;

/** Launches an unresolvable agent, asserting the shared missing-agent failure. */
const launchWithMissingAgent = (
  session: ReturnType<typeof createTestSession>,
  agent = '',
) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      buildAgentLaunchContext({
        config: AgentConfigSchema.parse({ agent, model: '' }),
        runId: EXECUTION_ID,
        session,
      }),
    );
    expect(error.message).toContain('Could not find agent');
  });

/**
 * Triggers the launch's queued (no live host attached) missing-agent failure
 * and asserts the shared claimed-presentation state, returning the owning
 * session so the caller can attach a host, assert on replay, and dispose it
 * (disposing earlier would drop the queued replay with the session).
 */
const triggerQueuedMissingAgentFailure = (session: SessionHandle) =>
  Effect.gen(function* () {
    const thrown = yield* Effect.flip(
      buildAgentLaunchContext({
        config: AgentConfigSchema.parse({
          agent: '__queued_missing_agent_for_launch_context_test__',
          model: '',
        }),
        runId: EXECUTION_ID,
        session,
      }),
    );
    expect(String(thrown)).toContain('Could not find agent');
    expect(hasErrorPresentationClaimed(thrown)).toBe(true);
    return session;
  });

beforeEach(() => {
  mocks.resolve.mockReturnValue(Effect.succeed(undefined));
});

describe('AgentLaunchContext', () => {
  it.effect(
    'publishes missing-agent banners through the supplied host interactions',
    () =>
      Effect.gen(function* () {
        // The banner claims the failure, so the launch catch adds no generic toast.
        const explicit = createRecordingHost();
        const session = createTestSession();
        yield* Effect.addFinalizer(() => closeSessionOf(session));
        yield* session.interactions.use(explicit.interactions);

        yield* launchWithMissingAgent(
          session,
          '__missing_agent_for_launch_context_test__',
        );

        expect(explicit.events).toEqual([
          {
            event: 'showAgentConfigBanner',
            payload: {
              agentName: '__missing_agent_for_launch_context_test__',
              category: AgentCategory.Workflow,
            },
          },
        ]);
      }),
  );

  it.effect(
    'renders a queued missing-agent banner once a live host replays it',
    () =>
      Effect.gen(function* () {
        // The retained replay renders the targeted banner and no generic toast.
        const recording = createRecordingHost();
        const session =
          yield* triggerQueuedMissingAgentFailure(createTestSession());
        const owner = session.interactions;

        yield* owner.use(recording.interactions);
        yield* settle;

        expect(
          recording.events.filter(
            (event) => event.event === 'showAgentConfigBanner',
          ),
        ).toHaveLength(1);
        expect(
          recording.events.filter(
            (event) => event.event === 'requestShowError',
          ),
        ).toHaveLength(0);
        yield* closeSessionOf(session);
      }),
  );

  it.effect(
    'falls back to the generic toast when a live host throws on the missing-agent banner',
    () =>
      Effect.gen(function* () {
        // A live host whose banner post throws synchronously (a renderer torn
        // down mid-post, #10466) must leave the failure unclaimed: it is
        // pre-registration, so no `result` event exists to present it instead.
        const events: string[] = [];
        const session = createTestSession();
        yield* Effect.addFinalizer(() => closeSessionOf(session));
        yield* session.interactions.use({
          emit: (event) => {
            if (event === 'showAgentConfigBanner') {
              throw new Error('renderer torn down mid-post');
            }
            events.push(event);
          },
        });

        yield* launchWithMissingAgent(session);

        expect(
          events.filter((event) => event === 'requestShowError'),
        ).toHaveLength(1);
      }),
  );

  it.effect(
    'emits the generic fallback when a queued banner replay throws synchronously',
    () =>
      Effect.gen(function* () {
        // The banner was queued (no host attached) and claimed; a host whose
        // replayed post throws must still surface the failure once (#10398).
        const events: string[] = [];
        const session =
          yield* triggerQueuedMissingAgentFailure(createTestSession());
        yield* session.interactions.use({
          emit: (event) => {
            if (event === 'showAgentConfigBanner') {
              throw new Error('renderer torn down mid-post');
            }
            events.push(event);
          },
        });
        yield* settle;

        expect(
          events.filter((event) => event === 'requestShowError'),
        ).toHaveLength(1);
        yield* closeSessionOf(session);
      }),
  );

  it.effect(
    'does not double-surface a model-not-recognized failure via the generic error toast',
    () =>
      Effect.gen(function* () {
        const recording = createRecordingHost();
        const session = createTestSession();
        yield* Effect.addFinalizer(() => closeSessionOf(session));
        yield* session.interactions.use(recording.interactions);

        mocks.resolve.mockReturnValueOnce(
          Effect.succeed({
            path: '/agents/chat.yaml',
            setting: { agentCategory: AgentCategory.ToolUse },
            prompt: {},
          }),
        );

        // Rejected while preparing the definition, before any execution is
        // registered for the unknown model.
        const error = yield* Effect.flip(
          prepareAgentDefinition({
            config: AgentConfigSchema.parse({
              agent: 'chat',
              model: '__unregistered_model_for_launch_context_test__',
            }),
            session,
          }),
        ).pipe(
          Effect.provide(
            Layer.merge(
              LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT),
              nodePlatformLayer,
            ),
          ),
          Effect.provide(fakeProcessServices()),
        );
        expect(error.message).toContain('is not registered');

        // Only the targeted instruction should fire; the generic `requestShowError`
        // catch-all must not repeat a failure the instruction already presented.
        expect(
          recording.events.filter(
            (event) => event.event === 'requestShowError',
          ),
        ).toEqual([]);
        expect(
          recording.events.filter(
            (event) => event.event === 'requestShowInstruction',
          ),
        ).toHaveLength(1);
      }),
  );

  it.effect(
    'presents an assembly failure once, through its terminal result',
    () =>
      Effect.gen(function* () {
        // Regression: the launch catch used to toast an assembly failure beside
        // the `result` event's own toast, so the user saw the error twice.
        const recording = createRecordingHost();
        const session = createTestSession();
        yield* session.interactions.use(recording.interactions);
        yield* Effect.addFinalizer(() => closeSessionOf(session));
        publishTestRunStart(session, EXECUTION_ID);
        yield* session.settlePublications();
        mocks.resolve.mockReturnValueOnce(
          Effect.succeed({
            path: '/agents/chat.yaml',
            setting: { agentCategory: AgentCategory.ToolUse },
            prompt: {},
          }),
        );
        mocks.buildVars.mockReturnValueOnce(
          Effect.fail(new Error('user vars unavailable')),
        );

        const exit = yield* Effect.exit(
          runWithLaunchGuard(
            session,
            EXECUTION_ID,
            buildAgentLaunchContext({
              config: AgentConfigSchema.parse({
                agent: 'chat',
                model: 'gpt55',
                agentCategory: AgentCategory.ToolUse,
              }),
              runId: EXECUTION_ID,
              session,
              resumed: true,
            }),
            {},
          ),
        );
        assert(Exit.isFailure(exit));
        expect(String(Cause.squash(exit.cause))).toContain(
          'user vars unavailable',
        );
        expect(
          recording.events.filter(
            (event) => event.event === 'requestShowError',
          ),
        ).toHaveLength(1);
      }),
  );

  it.effect(
    'commits the activation with creation instead of publishing a reservation',
    () =>
      Effect.gen(function* () {
        const session = createTestSession();
        yield* Effect.addFinalizer(() => closeSessionOf(session));
        const batches = vi.spyOn(session, 'commitRegistration');
        const recording = recordSessionEvents(session);
        mocks.resolve.mockReturnValueOnce(
          Effect.succeed({
            path: '/agents/chat.yaml',
            setting: { agentCategory: AgentCategory.ToolUse },
            prompt: {},
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
        const config = AgentConfigSchema.parse({
          agent: 'chat',
          model: 'gpt55',
          agentCategory: AgentCategory.ToolUse,
        });
        yield* registerRun(session, EXECUTION_ID, config, {
          identity: { kind: 'agent', agent: 'chat' },
        });
        yield* buildAgentLaunchContext({
          config,
          runId: EXECUTION_ID,
          session,
        });
        expect(batches.mock.calls[0]?.[0].map((event) => event.type)).toEqual([
          'run.start',
          'run.config',
          'run.activate',
        ]);
        expect(
          (yield* Effect.promise(() => recording.read()))
            .slice(0, 3)
            .map((event) => event.type),
        ).toEqual(['run.start', 'run.config', 'run.activate']);
        // One aggregate, one counter: the activation is the third durable
        // row of the creation batch, and the phase the fold reads from it.
        expect(
          (yield* Effect.promise(() => recording.read()))[2],
        ).toMatchObject({ seq: 3 });
      }),
  );

  it.effect(
    "restores a resumed run's human grants from its durable policy, not its goal's",
    () =>
      Effect.gen(function* () {
        // Failure modes: a resume in a new process forgets an
        // approve-for-session grant; its re-stamp overwrites the durable
        // grant with an empty snapshot; a goal's auto-approval comes back
        // on without a human re-arming it.
        const session = createTestSession();
        yield* Effect.addFinalizer(() => closeSessionOf(session));
        const config = AgentConfigSchema.parse({
          agent: 'chat',
          model: 'gpt55',
          agentCategory: AgentCategory.ToolUse,
        });
        const definitionMocks = () => {
          mocks.resolve.mockReturnValueOnce(
            Effect.succeed({
              path: '/agents/chat.yaml',
              setting: { agentCategory: AgentCategory.ToolUse },
              prompt: {},
            }),
          );
          mocks.buildVars.mockReturnValueOnce(
            Effect.succeed({
              inputs: {},
              catalog: [],
              attachedMemoryMisses: [],
            }),
          );
        };
        yield* registerRun(session, EXECUTION_ID, config, {
          identity: { kind: 'agent', agent: 'chat' },
        });
        // A human approves edits for the session; the run's goal then
        // auto-approves its commands.
        session.approvals.toolEdit.bypass.setBypass(EXECUTION_ID, true);
        setGoalSessionAutoApproval(session, EXECUTION_ID, 'commands');
        yield* session.settlePublications();
        // A new process: nothing of the run's approval state is in memory.
        session.approvals.clearAll();

        definitionMocks();
        yield* buildAgentLaunchContext({
          config,
          runId: EXECUTION_ID,
          session,
          resumed: true,
        });

        const restored = { bash: false, toolEdit: true, superYolo: false };
        expect(session.approvals.bypassesFor(EXECUTION_ID)).toEqual(restored);
        expect((yield* session.readView([])).policy.get(EXECUTION_ID)).toEqual(
          expect.objectContaining({
            bypasses: restored,
            own: { toolEdit: 'on' },
            goal: [],
          }),
        );
      }),
  );

  it.effect('ends a late launch-assembly failure on the launch terminal', () =>
    Effect.gen(function* () {
      const order: string[] = [];
      const failure = new Error('user vars unavailable');
      const postProcessResponse = vi.fn((text: string) => Effect.succeed(text));
      const responseTextProcessing = {
        postProcessResponse,
      };
      const session = createTestSession({
        responseTextProcessing,
      });
      yield* Effect.addFinalizer(() => closeSessionOf(session));
      publishTestRunStart(session, EXECUTION_ID);
      yield* session.settlePublications();
      const terminalEvents = recordSessionEvents(session);
      const stage = noopTrace.openStage('Run');
      const endStage = vi.spyOn(stage, 'end').mockImplementation(() => {
        order.push('stage');
      });
      const closeTrace = TraceEmitter.prototype.close;
      const close = vi
        .spyOn(TraceEmitter.prototype, 'close')
        .mockImplementation(function (this: TraceEmitter) {
          order.push('close');
          closeTrace.call(this);
        });
      const openStage = vi
        .spyOn(TraceEmitter.prototype, 'openStage')
        .mockReturnValue(stage);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          openStage.mockRestore();
          close.mockRestore();
        }),
      );
      mocks.resolve.mockReturnValueOnce(
        Effect.succeed({
          path: '/agents/chat.yaml',
          setting: { agentCategory: AgentCategory.ToolUse },
          prompt: {},
        }),
      );
      mocks.buildVars.mockReturnValueOnce(Effect.fail(failure));

      const error = yield* Effect.flip(
        runWithLaunchGuard(
          session,
          EXECUTION_ID,
          buildAgentLaunchContext({
            config: AgentConfigSchema.parse({
              agent: 'chat',
              model: 'gpt55',
              agentCategory: AgentCategory.ToolUse,
            }),
            runId: EXECUTION_ID,
            session,
            resumed: true,
            suppressErrorNotification: true,
          }),
          {},
        ),
      );
      expect(error).toBe(failure);

      expect(mocks.buildVars.mock.calls.at(-1)?.at(5)).toEqual({
        workspacePath: session.roots.workspace,
        storageRoot: session.roots.storage,
        stageId: undefined,
      });
      expect(endStage).toHaveBeenCalledExactlyOnceWith(RUN_OUTCOME.FAILED);
      expect(session.runView(EXECUTION_ID)?.status).toBe(RUN_PHASE.FAILED);
      expect(close).toHaveBeenCalledOnce();
      // The launch's scope unwinds first (its stage, then its trace); the
      // launch terminal then ends the run it left open.
      expect(yield* Effect.promise(() => terminalEvents.read())).toContainEqual(
        expect.objectContaining({
          type: 'run.end',
          outcome: RUN_OUTCOME.FAILED,
        }),
      );
      expect(order).toEqual(['stage', 'close']);
    }),
  );
});
