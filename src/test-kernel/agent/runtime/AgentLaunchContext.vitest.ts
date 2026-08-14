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
import { useRunContext } from '@agent/runtime/RunContext';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  buildAgentLaunchContext,
  getAgentPath,
  withExecutionRunContext,
  type AgentLaunchContext,
} from '@agent/runtime/AgentLaunchContext';
import { RUN_OUTCOME, STREAM_PHASE, AgentCategory } from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';
import { testModelCell } from '../modelCellTestUtils';
import { createRecordingHost } from '../progressTestUtils';

describe('AgentLaunchContext', () => {
  it('still rejects empty canonical values, now at agent resolution', async () => {
    // The pre-mint missing-field guard died with the model-keyed stream id
    // (Axis T): an empty agent now fails agent resolution instead of a
    // dedicated field check, but it must still fail the launch.
    const session = createTestSession();
    try {
      await expect(
        buildAgentLaunchContext({
          config: AgentConfigSchema.parse({ agent: '', model: '' }),
          session,
        }),
      ).rejects.toThrow('Could not find agent');
    } finally {
      session.dispose();
    }
  });

  it('publishes missing-agent banners through the supplied host interactions', async () => {
    const explicit = createRecordingHost();

    await expect(
      getAgentPath(
        '__missing_agent_for_launch_context_test__',
        explicit.host,
        AgentCategory.ToolUse,
      ),
    ).rejects.toThrow('Could not find agent');

    expect(explicit.events).toEqual([
      {
        event: 'showAgentConfigBanner',
        payload: {
          agentName: '__missing_agent_for_launch_context_test__',
        },
      },
    ]);
  });

  it('still falls back to the generic error toast for a missing-agent failure', async () => {
    // Deliberately NOT deduplicated (unlike model-not-recognized below):
    // `showAgentConfigBanner` is a documented no-op on both CLI presentation
    // hosts, so marking this failure as "presented" would leave CLI users
    // with no visible error at all. See the comment at `getAgentPath`'s
    // throw site.
    const recording = createRecordingHost();
    const session = createTestSession({ interactions: recording.host });

    try {
      await expect(
        buildAgentLaunchContext({
          config: AgentConfigSchema.parse({ agent: '', model: '' }),
          session,
        }),
      ).rejects.toThrow('Could not find agent');
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

  it('does not double-surface a model-not-recognized failure via the generic error toast', async () => {
    const recording = createRecordingHost();
    const session = createTestSession({ interactions: recording.host });

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
    const ctx = {
      runScope,
      logger: noopTrace,
      modelCell,
      config: {
        agent: runScope.agentName,
        model: 'deepseekT',
      },
    } as unknown as AgentLaunchContext;

    await withExecutionRunContext(
      ctx,
      {
        approvalPromptsUnavailable: true,
        runtimeUnavailableTools: ['inquiry'],
        stopAfterCycle: true,
      },
      async () => {
        const context = useRunContext();
        expect(context.model).toBe('deepseekT');
        expect(context.kind).toBe('launch');
        if (context.kind !== 'launch') {
          throw new Error('expected launch context');
        }
        expect(context.runScope).toBe(runScope);
        expect(context.approvalPromptsUnavailable).toBe(true);
        expect(context.runtimeUnavailableTools).toEqual(['inquiry']);
        expect(context.stopAfterCycle).toBe(true);

        // The cell is the run's live model, so a swap alone moves the run
        // context; the `AgentConfig.model` mirror does not drive it.
        modelCell.swap({ dispose: vi.fn() } as never, 'sonnet46T');

        expect(useRunContext().model).toBe('sonnet46T');
      },
    );
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
    const detachEvents = session.events.subscribe(() => undefined);
    const detachStatus = session.events.subscribeStatus(({ phase }) => {
      if (phase === STREAM_PHASE.FAILED) order.push('terminal');
    });
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
      expect(order).toEqual([
        'stage',
        'handler',
        'terminal',
        'detach',
        'raw-trace',
      ]);
    } finally {
      detachEvents();
      detachStatus();
      session.dispose();
    }
  });
});
