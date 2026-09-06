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
import { createRunScope } from '@agent/runtime/RunScope';
import { tryUseRunContext } from '@agent/runtime/RunContext';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { createToolPolicy } from '@agent/core/flows/BaseFlowServices';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  buildAgentLaunchContext,
  withExecutionRunContext,
  type AgentLaunchContext,
} from '@agent/runtime/AgentLaunchContext';
import { hasErrorPresentationClaimed } from '@common/errors/sdkError/errorMetadata';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
  STREAM_SUBSTATE,
  AgentCategory,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { testModelCell } from '../modelCellTestUtils';
import { createRecordingHost, recordSessionEvents } from '../progressTestUtils';

const EXECUTION_ID = 'a00101' as ExecutionId;

/** Launches an unresolvable agent, asserting the shared missing-agent failure. */
async function launchWithMissingAgent(
  session: ReturnType<typeof createTestSession>,
  agent = '',
): Promise<void> {
  await expect(
    buildAgentLaunchContext({
      config: AgentConfigSchema.parse({ agent, model: '' }),
      executionId: EXECUTION_ID,
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
    executionId: EXECUTION_ID,
    session,
  }).catch((error: unknown) => {
    thrown = error;
  });
  expect(String(thrown)).toContain('Could not find agent');
  expect(hasErrorPresentationClaimed(thrown)).toBe(true);
  return session;
}

describe('AgentLaunchContext', () => {
  it('still rejects empty canonical values, now at agent resolution', async () => {
    // The pre-mint missing-field guard died with the model-keyed stream id
    // (Axis T): an empty agent now fails agent resolution instead of a
    // dedicated field check, but it must still fail the launch.
    const session = createTestSession();
    try {
      await launchWithMissingAgent(session);
    } finally {
      session.dispose();
    }
  });

  it('publishes missing-agent banners through the supplied host interactions', async () => {
    // Delivery is confirmed so the launch catch adds no generic toast; the
    // undelivered variant is covered by the generic-error-toast test below.
    const explicit = createRecordingHost({ emitDelivery: true });
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

  it('keeps the generic error toast when the missing-agent banner is not delivered', async () => {
    // A host that reports no delivery (for example an older/no-op adapter)
    // must still surface the launch failure once through the generic toast.
    const recording = createRecordingHost({ emitDelivery: false });
    const session = createTestSession();
    session.interactions.use(recording.interactions);

    try {
      await launchWithMissingAgent(session);
    } finally {
      session.dispose();
    }

    expect(
      recording.events.filter((event) => event.event === 'requestShowError'),
    ).toHaveLength(1);
    expect(
      recording.events.filter(
        (event) => event.event === 'showAgentConfigBanner',
      ),
    ).toHaveLength(1);
  });

  it('renders a queued missing-agent banner once a live host replays it', async () => {
    // The retained replay owns the delivery decision: it renders the targeted
    // banner and emits no generic fallback.
    const recording = createRecordingHost({ emitDelivery: true });
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

  it('emits the generic fallback when a queued missing-agent banner replay is not delivered', async () => {
    const recording = createRecordingHost({ emitDelivery: false });
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
    ).toHaveLength(1);
    session.dispose();
  });

  it('emits the generic fallback when a queued banner replay throws synchronously', async () => {
    // A host adapter whose emit throws synchronously (e.g. a desktop renderer
    // post during teardown) escapes the replay closure's promise chain. It
    // must still trip the not-delivered fallback — otherwise the launch
    // error stays presentation-pending and surfaces zero times (#10398).
    const events: Array<{ event: string; payload: unknown }> = [];
    const session = await triggerQueuedMissingAgentFailure(createTestSession());
    const owner = session.interactions;

    owner.use({
      emit: (event, payload) => {
        if (event === 'showAgentConfigBanner') {
          throw new Error('renderer torn down mid-post');
        }
        events.push({ event, payload });
        return false;
      },
      cancel: () => {},
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(
      events.filter((entry) => entry.event === 'requestShowError'),
    ).toHaveLength(1);
    session.dispose();
  });

  it('normalizes a live-host synchronous banner throw into the generic toast fallback', async () => {
    // A live (already attached) host whose emit throws synchronously is
    // normalized to `false` by `SessionHostInteractions.emit`, leaving the
    // error unmarked so the launch catch emits the generic fallback on the
    // same host (#10466).
    const events: Array<{ event: string; payload: unknown }> = [];
    const session = createTestSession();
    const owner = session.interactions;
    owner.use({
      emit: (event, payload) => {
        if (event === 'showAgentConfigBanner') {
          throw new Error('renderer torn down mid-post');
        }
        events.push({ event, payload });
        return false;
      },
      cancel: () => {},
    });
    let thrown: unknown;

    try {
      await buildAgentLaunchContext({
        config: AgentConfigSchema.parse({ agent: '', model: '' }),
        executionId: EXECUTION_ID,
        session,
      }).catch((error: unknown) => {
        thrown = error;
      });
    } finally {
      session.dispose();
    }

    expect(String(thrown)).toContain('Could not find agent');
    expect(hasErrorPresentationClaimed(thrown)).toBe(false);
    expect(
      events.filter((entry) => entry.event === 'requestShowError'),
    ).toHaveLength(1);
    owner.dispose();
  });

  it('does not queue a second generic toast while a missing-agent banner replay is pending', async () => {
    const recording = createRecordingHost({ emitDelivery: false });
    const session = createTestSession();
    const owner = session.interactions;

    try {
      await launchWithMissingAgent(session);

      // The launch catch saw the pending-replay marker and left the fallback
      // to the queued targeted event; it must not have queued a duplicate.
      expect(recording.events).toEqual([]);

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
      ).toHaveLength(1);
    } finally {
      session.dispose();
    }
  });

  it('does not double-surface a model-not-recognized failure via the generic error toast', async () => {
    const recording = createRecordingHost({ emitDelivery: true });
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
      await expect(
        buildAgentLaunchContext({
          config: AgentConfigSchema.parse({
            agent: 'chat',
            model: '__unregistered_model_for_launch_context_test__',
          }),
          executionId: EXECUTION_ID,
          session,
        }),
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

  it('projects model changes into the active run context', async () => {
    const session = {} as SessionHandle;
    const executionId = 'launch-context-execution';
    const runScope = createRunScope({
      streamId: 'launch-context-stream',
      executionId,
      agentName: 'chat',
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
        agent: runScope.agentName,
        model: 'deepseekT',
      },
    } as unknown as AgentLaunchContext;

    await withExecutionRunContext(ctx, { onApprovalPolicyDenial }, async () => {
      const context = tryUseRunContext()!;
      expect(context.model).toBe('deepseekT');
      expect(context.kind).toBe('launch');
      if (context.kind !== 'launch') {
        throw new Error('expected launch context');
      }
      expect(context.runScope).toBe(runScope);
      // `withExecutionRunContext` projects `ctx.toolPolicy` into the ambient
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

  it('projects an empty tool policy as absent ambient fields', async () => {
    const session = {} as SessionHandle;
    const runScope = createRunScope({
      streamId: 'launch-context-defaults',
      executionId: 'launch-context-defaults-execution',
      agentName: 'chat',
      session,
      signal: new AbortController().signal,
    });
    const modelCell = testModelCell({ dispose: vi.fn() }, 'deepseekT');
    const ctx = {
      runScope,
      logger: noopTrace,
      modelCell,
      toolPolicy: createToolPolicy(),
      config: { agent: runScope.agentName, model: 'deepseekT' },
    } as unknown as AgentLaunchContext;

    await withExecutionRunContext(ctx, {}, async () => {
      const context = tryUseRunContext()!;
      if (context.kind !== 'launch') {
        throw new Error('expected launch context');
      }
      expect(context.approvalPromptsUnavailable).toBeUndefined();
      expect(context.runtimeUnavailableTools).toBeUndefined();
      expect(context.stopAfterCycle).toBeUndefined();
      expect(context.onApprovalPolicyDenial).toBeUndefined();
    });
  });

  it('commits initial status with creation instead of publishing a reservation', async () => {
    const session = createTestSession();
    const batches = vi.spyOn(session, 'publish');
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
    try {
      const context = await buildAgentLaunchContext({
        config: AgentConfigSchema.parse({
          agent: 'chat',
          model: 'gpt55',
          agentCategory: AgentCategory.ToolUse,
        }),
        executionId: EXECUTION_ID,
        session,
        modelHandlerCompatibilityKey: 'ModelHandlerOpenAIResponse',
      });
      try {
        expect(batches.mock.calls[0]?.[0].map((event) => event.type)).toEqual([
          'run.start',
          'run.activate',
          'status',
        ]);
        expect(recording.events.slice(0, 3).map((event) => event.type)).toEqual(
          ['run.start', 'run.activate', 'status'],
        );
        expect(recording.events[2]).toMatchObject({
          seq: 3,
          phase: STREAM_PHASE.RUNNING,
          substate: STREAM_SUBSTATE.STARTING,
          runStartedAt: session.status.getStreamState(context.runScope.streamId)
            ?.runStartedAt,
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
    publishTestRunStart(session, 'late-assembly-stream', EXECUTION_ID);
    // The recorder-style status port hears the terminal fact in publish
    // order, before any renderer wakes.
    const detachStatus = session.attachRunTrace(
      {
        trace: noopTrace,
        handleStatus: ({ phase }) => {
          if (phase === STREAM_PHASE.FAILED) order.push('terminal');
        },
      },
      'stream:launch-context-order' as StreamTabId,
    );
    const stage = noopTrace.openStage('Run');
    const endStage = vi.spyOn(stage, 'end').mockImplementation(() => {
      order.push('stage');
    });
    const detachTrace = vi.fn(() => order.push('detach'));
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
          executionId: EXECUTION_ID,
          session,
          streamTabIdOverride: 'late-assembly-stream',
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
      expect(session.status.get('late-assembly-stream')).toBe(
        STREAM_PHASE.FAILED,
      );
      expect(detachTrace).toHaveBeenCalledOnce();
      expect(rawDispose).toHaveBeenCalledOnce();
      // LIFO store unwind: the load-bearing constraint is compensation
      // ('terminal') strictly before trace detach/disposal.
      expect(order).toEqual([
        'stage',
        'terminal',
        'detach',
        'raw-trace',
        'handler',
      ]);
    } finally {
      detachStatus();
      session.dispose();
    }
  });
});
