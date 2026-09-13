import { it } from '@effect/vitest';
import { Cause, Effect, Exit } from 'effect';
import { assert, describe, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  load: vi.fn(),
  createTrace: vi.fn(),
  buildVars: vi.fn(),
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

import { noopTrace } from '@agent/trace';
import { registerRun } from '@agent/storage/runLifecycle';
import { createRunScope } from '@agent/runtime/RunScope';
import { tryUseRunContext } from '@agent/runtime/RunContext';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  buildAgentLaunchContext as buildAgentLaunchContextEffect,
  withLaunchRunContext,
  type AgentLaunchContext,
  prepareAgentDefinition,
} from '@agent/runtime/AgentLaunchContext';
import { attachTerminalResultToast } from '@agent/runtime/terminalResultToast';
import { hasErrorPresentationClaimed } from '@common/errors/sdkError/errorMetadata';
import {
  RUN_OUTCOME,
  RUN_PHASE,
  AgentCategory,
  type RunId,
} from '@shared/schemas';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { fakeProcessServices } from '@test/support/setupPlatform';
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

describe('AgentLaunchContext', () => {
  it.effect(
    'publishes missing-agent banners through the supplied host interactions',
    () =>
      Effect.gen(function* () {
        // The banner claims the failure, so the launch catch adds no generic toast.
        const explicit = createRecordingHost();
        const session = createTestSession();
        session.interactions.use(explicit.interactions);

        try {
          yield* launchWithMissingAgent(
            session,
            '__missing_agent_for_launch_context_test__',
          );
        } finally {
          session.dispose();
        }

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

        owner.use(recording.interactions);
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
        session.dispose();
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
        session.interactions.use({
          emit: (event) => {
            if (event === 'showAgentConfigBanner') {
              throw new Error('renderer torn down mid-post');
            }
            events.push(event);
          },
        });

        try {
          yield* launchWithMissingAgent(session);
        } finally {
          session.dispose();
        }

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
        session.interactions.use({
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
        session.dispose();
      }),
  );

  it.effect(
    'does not double-surface a model-not-recognized failure via the generic error toast',
    () =>
      Effect.gen(function* () {
        const recording = createRecordingHost();
        const session = createTestSession();
        session.interactions.use(recording.interactions);

        mocks.resolve.mockReturnValueOnce({ path: '/agents/chat.yaml' });
        mocks.load.mockResolvedValueOnce([
          { agentCategory: AgentCategory.ToolUse },
          {},
        ]);

        try {
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
          );
          expect(error.message).toContain('is not registered');
        } finally {
          session.dispose();
        }

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
        session.interactions.use(recording.interactions);
        const detachToast = attachTerminalResultToast(
          session,
          session.interactions,
        );
        publishTestRunStart(session, EXECUTION_ID);
        mocks.resolve.mockReturnValueOnce({ path: '/agents/chat.yaml' });
        mocks.load.mockResolvedValueOnce([
          { agentCategory: AgentCategory.ToolUse },
          {},
        ]);
        mocks.createTrace.mockImplementationOnce(() => {
          throw new Error('trace failed');
        });

        try {
          const exit = yield* Effect.exit(
            buildAgentLaunchContext({
              config: AgentConfigSchema.parse({
                agent: 'chat',
                model: 'gpt55',
                agentCategory: AgentCategory.ToolUse,
              }),
              runId: EXECUTION_ID,
              session,
              resumed: true,
              modelCompatibilityKey: 'OpenAIResponse',
            }),
          );
          assert(Exit.isFailure(exit));
          expect(String(Cause.squash(exit.cause))).toContain('trace failed');
          expect(
            recording.events.filter(
              (event) => event.event === 'requestShowError',
            ),
          ).toHaveLength(1);
        } finally {
          detachToast();
          session.dispose();
        }
      }),
  );

  it('projects model changes into the active run context', async () => {
    const session = {} as SessionHandle;
    const runId = 'launch-context-run' as RunId;
    const runScope = createRunScope({
      runId,
      session,
      signal: new AbortController().signal,
    });
    const onApprovalPolicyDenial = vi.fn();
    const ctx = {
      runScope,
      logger: noopTrace,
      toolPolicy: {
        approvalPromptsUnavailable: true,
        runtimeUnavailableTools: ['inquiry'],
        stopAfterCycle: true,
      },
      config: {
        agent: 'chat',
        model: 'deepseekT',
      },
    } as unknown as AgentLaunchContext;

    await withLaunchRunContext(ctx, { onApprovalPolicyDenial }, async () => {
      const context = tryUseRunContext()!;
      expect(context.model).toBe('deepseekT');
      expect(context.kind).toBe('launch');
      if (context.kind !== 'launch') {
        throw new Error('expected launch context');
      }
      expect(context.runScope).toBe(runScope);
      // `withLaunchRunContext` projects `ctx.toolPolicy` into the ambient
      // RunContext; the only explicit option left is `onApprovalPolicyDenial`.
      expect(context.approvalPromptsUnavailable).toBe(true);
      expect(context.runtimeUnavailableTools).toEqual(['inquiry']);
      expect(context.stopAfterCycle).toBe(true);
      expect(context.onApprovalPolicyDenial).toBe(onApprovalPolicyDenial);

      // The run mirrors a switch into its config once the new binding is
      // live (`onModelChanged`); the context reads it at read time.
      ctx.config.model = 'sonnet46T';

      expect(tryUseRunContext()?.model).toBe('sonnet46T');
    });
  });

  it.effect(
    'commits the activation with creation instead of publishing a reservation',
    () =>
      Effect.gen(function* () {
        const session = createTestSession();
        const batches = vi.spyOn(session, 'commitRegistration');
        const recording = recordSessionEvents(session);
        mocks.resolve.mockReturnValueOnce({ path: '/agents/chat.yaml' });
        mocks.load.mockResolvedValueOnce([
          { agentCategory: AgentCategory.ToolUse },
          {},
        ]);
        mocks.createTrace.mockReturnValueOnce({
          trace: noopTrace,
          handleStatus: () => {},
          dispose: vi.fn(),
        });
        mocks.buildVars.mockResolvedValueOnce({ ATTACHED_MEMORY_MISSES: [] });
        const config = AgentConfigSchema.parse({
          agent: 'chat',
          model: 'gpt55',
          agentCategory: AgentCategory.ToolUse,
        });
        try {
          yield* registerRun(session, EXECUTION_ID, config, 'chat', {
            identity: { kind: 'agent', agent: 'chat' },
          });
          const context = yield* buildAgentLaunchContext({
            config,
            runId: EXECUTION_ID,
            session,
            modelCompatibilityKey: 'OpenAIResponse',
          });
          try {
            expect(
              batches.mock.calls[0]?.[0].map((event) => event.type),
            ).toEqual([
              'run.start',
              'run.launchLabel',
              'run.record',
              'run.activate',
            ]);
            expect(
              (yield* Effect.promise(() => recording.read()))
                .slice(0, 2)
                .map((event) => event.type),
            ).toEqual(['run.start', 'run.activate']);
            // One aggregate, one counter: the activation is the fourth durable
            // row of the creation batch, and the phase the fold reads from it.
            expect(
              (yield* Effect.promise(() => recording.read()))[1],
            ).toMatchObject({ seq: 4 });
          } finally {
            context.disposeTrace();
          }
        } finally {
          session.dispose();
        }
      }),
  );

  it.effect(
    'compensates a late launch-assembly failure before trace disposal',
    () =>
      Effect.gen(function* () {
        const order: string[] = [];
        const failure = new Error('user vars unavailable');
        const delegationAgentScope = {
          workflow: ['builtInWorkflow:correct'],
          toolUse: ['builtInToolUse:orchestrator'],
        };
        const postProcessResponse = vi.fn((text: string) => text);
        const responseTextProcessing = {
          normalizeResponseText: (text: string) => text,
          postProcessResponse,
          connectResponseText: () => Effect.succeed(' '),
        };
        const session = createTestSession({
          responseTextProcessing,
        });
        publishTestRunStart(session, EXECUTION_ID);
        const terminalEvents = recordSessionEvents(session);
        const stage = noopTrace.openStage('Run');
        const endStage = vi.spyOn(stage, 'end').mockImplementation(() => {
          order.push('stage');
        });
        const detachTrace = vi.fn(() => {
          order.push('detach');
          return terminalEvents.read();
        });
        const rawDispose = vi.fn(() => order.push('raw-trace'));
        const trace = { ...noopTrace, subscribe: vi.fn(() => detachTrace) };
        trace.openStage = vi.fn(() => stage);
        mocks.resolve.mockReturnValueOnce({ path: '/agents/chat.yaml' });
        mocks.load.mockResolvedValueOnce([
          { agentCategory: AgentCategory.ToolUse },
          {},
        ]);
        mocks.createTrace.mockReturnValueOnce({ trace, dispose: rawDispose });
        mocks.buildVars.mockRejectedValueOnce(failure);

        try {
          const error = yield* Effect.flip(
            buildAgentLaunchContext({
              config: AgentConfigSchema.parse({
                agent: 'chat',
                model: 'gpt55',
                agentCategory: AgentCategory.ToolUse,
                delegationAgentScope,
              }),
              runId: EXECUTION_ID,
              session,
              resumed: true,
              suppressErrorNotification: true,
              modelCompatibilityKey: 'OpenAIResponse',
            }),
          );
          expect(error).toBe(failure);

          expect(mocks.buildVars.mock.calls.at(-1)?.at(6)).toEqual({
            delegationAgentScope,
          });
          expect(endStage).toHaveBeenCalledExactlyOnceWith(RUN_OUTCOME.FAILED);
          expect(session.runView(EXECUTION_ID)?.status).toBe(RUN_PHASE.FAILED);
          expect(detachTrace).toHaveBeenCalledOnce();
          expect(
            yield* Effect.promise(() => detachTrace.mock.results[0]!.value),
          ).toContainEqual(
            expect.objectContaining({
              type: 'run.end',
              outcome: RUN_OUTCOME.FAILED,
            }),
          );
          expect(rawDispose).toHaveBeenCalledOnce();
          // Terminal compensation is committed before the trace is detached.
          expect(order).toEqual(['stage', 'detach', 'raw-trace']);
        } finally {
          session.dispose();
        }
      }),
  );
});
