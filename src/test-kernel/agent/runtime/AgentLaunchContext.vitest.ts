import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  load: vi.fn(),
  createHandler: vi.fn(),
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
vi.mock('@agent/runtime/ModelFactory', () => ({
  createModelHandler: mocks.createHandler,
  createModelHandlerForCompatibilityKey: mocks.createHandler,
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
import { createToolPolicy } from '@agent/core/flows/BaseFlowServices';
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
  RUN_SUBSTATE,
  AgentCategory,
  type RunId,
} from '@shared/schemas';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { testModelCell } from '../modelCellTestUtils';
import { createRecordingHost, recordSessionEvents } from '../progressTestUtils';

const buildAgentLaunchContext = (
  input: Omit<
    Parameters<typeof buildAgentLaunchContextEffect>[0],
    'definition'
  > &
    Parameters<typeof prepareAgentDefinition>[0],
) =>
  Effect.runPromise(
    prepareAgentDefinition(input).pipe(
      Effect.flatMap((definition) =>
        buildAgentLaunchContextEffect({ ...input, definition }),
      ),
    ),
  );

const EXECUTION_ID = 'a00101' as RunId;

/** Launches an unresolvable agent, asserting the shared missing-agent failure. */
async function launchWithMissingAgent(
  session: ReturnType<typeof createTestSession>,
  agent = '',
): Promise<void> {
  await expect(
    buildAgentLaunchContext({
      config: AgentConfigSchema.parse({ agent, model: '' }),
      runId: EXECUTION_ID,
      session,
    }),
  ).rejects.toThrow('Could not find agent');
}

/**
 * Triggers the launch's queued (no live host attached) missing-agent failure
 * and asserts the shared claimed-presentation state, returning the owning
 * session so the caller can attach a host, assert on replay, and dispose it
 * (disposing earlier would drop the queued replay with the session).
 */
async function triggerQueuedMissingAgentFailure(
  session: SessionHandle,
): Promise<SessionHandle> {
  let thrown: unknown;
  await buildAgentLaunchContext({
    config: AgentConfigSchema.parse({
      agent: '__queued_missing_agent_for_launch_context_test__',
      model: '',
    }),
    runId: EXECUTION_ID,
    session,
  }).catch((error: unknown) => {
    thrown = error;
  });
  expect(String(thrown)).toContain('Could not find agent');
  expect(hasErrorPresentationClaimed(thrown)).toBe(true);
  return session;
}

describe('AgentLaunchContext', () => {
  it('publishes missing-agent banners through the supplied host interactions', async () => {
    // The banner claims the failure, so the launch catch adds no generic toast.
    const explicit = createRecordingHost();
    const session = createTestSession();
    session.interactions.use(explicit.interactions);

    try {
      await launchWithMissingAgent(
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
  });

  it('renders a queued missing-agent banner once a live host replays it', async () => {
    // The retained replay renders the targeted banner and no generic toast.
    const recording = createRecordingHost();
    const session = await triggerQueuedMissingAgentFailure(createTestSession());
    const owner = session.interactions;

    owner.use(recording.interactions);
    await Promise.resolve();
    await Promise.resolve();

    expect(
      recording.events.filter(
        (event) => event.event === 'showAgentConfigBanner',
      ),
    ).toHaveLength(1);
    expect(
      recording.events.filter((event) => event.event === 'requestShowError'),
    ).toHaveLength(0);
    session.dispose();
  });

  it('falls back to the generic toast when a live host throws on the missing-agent banner', async () => {
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
      cancel: () => {},
    });

    try {
      await launchWithMissingAgent(session);
    } finally {
      session.dispose();
    }

    expect(events.filter((event) => event === 'requestShowError')).toHaveLength(
      1,
    );
  });

  it('does not double-surface a model-not-recognized failure via the generic error toast', async () => {
    const recording = createRecordingHost();
    const session = createTestSession();
    session.interactions.use(recording.interactions);

    mocks.resolve.mockReturnValueOnce({
      entry: { path: '/agents/chat.yaml' },
    });
    mocks.load.mockResolvedValueOnce([
      { agentCategory: AgentCategory.ToolUse },
      {},
    ]);

    try {
      // Rejected while preparing the definition, before any execution is
      // registered for the unknown model.
      await expect(
        Effect.runPromise(
          prepareAgentDefinition({
            config: AgentConfigSchema.parse({
              agent: 'chat',
              model: '__unregistered_model_for_launch_context_test__',
            }),
            session,
          }),
        ),
      ).rejects.toThrow('is not registered');
    } finally {
      session.dispose();
    }

    // Only the targeted instruction should fire; the generic `requestShowError`
    // catch-all must not repeat a failure the instruction already presented.
    expect(
      recording.events.filter((event) => event.event === 'requestShowError'),
    ).toEqual([]);
    expect(
      recording.events.filter(
        (event) => event.event === 'requestShowInstruction',
      ),
    ).toHaveLength(1);
  });

  it('presents an assembly failure once, through its terminal result', async () => {
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
    mocks.resolve.mockReturnValueOnce({ entry: { path: '/agents/chat.yaml' } });
    mocks.load.mockResolvedValueOnce([
      { agentCategory: AgentCategory.ToolUse },
      {},
    ]);
    mocks.createHandler.mockRejectedValueOnce(new Error('handler failed'));

    try {
      await expect(
        buildAgentLaunchContext({
          config: AgentConfigSchema.parse({
            agent: 'chat',
            model: 'gpt55',
            agentCategory: AgentCategory.ToolUse,
          }),
          runId: EXECUTION_ID,
          session,
          resumed: true,
          modelHandlerCompatibilityKey: 'ModelHandlerOpenAIResponse',
        }),
      ).rejects.toThrow('handler failed');
      expect(
        recording.events.filter((event) => event.event === 'requestShowError'),
      ).toHaveLength(1);
    } finally {
      detachToast();
      session.dispose();
    }
  });

  it('projects model changes into the active run context', async () => {
    const session = {} as SessionHandle;
    const runId = 'launch-context-run' as RunId;
    const runScope = createRunScope({
      runId,
      session,
      signal: new AbortController().signal,
    });
    const modelCell = testModelCell({ dispose: vi.fn() }, 'deepseekT');
    const onApprovalPolicyDenial = vi.fn();
    const ctx = {
      runScope,
      logger: noopTrace,
      modelCell,
      toolPolicy: createToolPolicy({
        approvalPromptsUnavailable: true,
        runtimeUnavailableTools: ['inquiry'],
        stopAfterCycle: true,
      }),
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

      // The cell is the run's live model, so a swap alone moves the run
      // context; the `AgentConfig.model` mirror does not drive it.
      modelCell.swap({ dispose: vi.fn() } as never, 'sonnet46T');

      expect(tryUseRunContext()?.model).toBe('sonnet46T');
    });
  });

  it('commits initial status with creation instead of publishing a reservation', async () => {
    const session = createTestSession();
    const batches = vi.spyOn(session, 'commitRegistration');
    const recording = recordSessionEvents(session);
    const handler = {
      capabilities: { supportsVision: false, supportsNativeAudio: false },
      config: { provider: 'openai' },
      setAgentCategory: vi.fn(),
      setLogger: vi.fn(),
      dispose: vi.fn(),
    };
    mocks.resolve.mockReturnValueOnce({ entry: { path: '/agents/chat.yaml' } });
    mocks.load.mockResolvedValueOnce([
      { agentCategory: AgentCategory.ToolUse },
      {},
    ]);
    mocks.createHandler.mockResolvedValueOnce(handler);
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
      await Effect.runPromise(
        registerRun(session, EXECUTION_ID, config, 'chat', {
          identity: { kind: 'agent', agent: 'chat' },
        }),
      );
      const context = await buildAgentLaunchContext({
        config,
        runId: EXECUTION_ID,
        session,
        modelHandlerCompatibilityKey: 'ModelHandlerOpenAIResponse',
      });
      try {
        expect(batches.mock.calls[0]?.[0].map((event) => event.type)).toEqual([
          'run.start',
          'run.launchLabel',
          'run.record',
          'run.activate',
          'status',
        ]);
        expect(
          (await recording.read()).slice(0, 3).map((event) => event.type),
        ).toEqual(['run.start', 'run.activate', 'status']);
        // One aggregate, one counter: the status is the fifth durable row of
        // the creation batch.
        expect((await recording.read())[2]).toMatchObject({
          seq: 5,
          phase: RUN_PHASE.RUNNING,
          substate: RUN_SUBSTATE.STARTING,
          runStartedAt: expect.any(Number),
        });
      } finally {
        context.disposeTrace();
        handler.dispose();
      }
    } finally {
      session.dispose();
    }
  });

  it('compensates a late launch-assembly failure before trace disposal', async () => {
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
      connectResponseText: async () => ' ',
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
    const handler = {
      capabilities: { supportsVision: false, supportsNativeAudio: false },
      config: { provider: 'openai' },
      setAgentCategory: vi.fn(),
      setLogger: vi.fn(),
      dispose: vi.fn(() => order.push('handler')),
    };

    mocks.resolve.mockReturnValueOnce({
      entry: { path: '/agents/chat.yaml' },
    });
    mocks.load.mockResolvedValueOnce([
      { agentCategory: AgentCategory.ToolUse },
      {},
    ]);
    mocks.createHandler.mockResolvedValueOnce(handler);
    mocks.createTrace.mockReturnValueOnce({ trace, dispose: rawDispose });
    mocks.buildVars.mockRejectedValueOnce(failure);

    try {
      await expect(
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
          modelHandlerCompatibilityKey: 'ModelHandlerOpenAIResponse',
        }),
      ).rejects.toBe(failure);

      expect(mocks.buildVars.mock.calls.at(-1)?.at(6)).toEqual({
        delegationAgentScope,
      });
      expect(mocks.createHandler.mock.calls.at(-1)?.at(2)).toBe(
        responseTextProcessing,
      );
      expect(endStage).toHaveBeenCalledExactlyOnceWith(RUN_OUTCOME.FAILED);
      expect(handler.dispose).toHaveBeenCalledOnce();
      expect(session.status.get(EXECUTION_ID)).toBe(RUN_PHASE.FAILED);
      expect(detachTrace).toHaveBeenCalledOnce();
      await expect(detachTrace.mock.results[0]?.value).resolves.toContainEqual(
        expect.objectContaining({ type: 'status', phase: RUN_PHASE.FAILED }),
      );
      expect(rawDispose).toHaveBeenCalledOnce();
      // Terminal compensation is committed before the trace is detached.
      expect(order).toEqual(['stage', 'detach', 'raw-trace', 'handler']);
    } finally {
      session.dispose();
    }
  });
});
