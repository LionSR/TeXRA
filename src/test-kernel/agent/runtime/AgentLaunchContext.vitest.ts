// Third-party imports
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
vi.mock('@agent/utils/userVars', () => ({ buildUserVars: mocks.buildVars }));

// Local imports
import { noopTrace } from '@agent/trace';
import {
  buildAgentLaunchContext,
  getAgentPath,
  withExecutionRunContext,
  type AgentLaunchContext,
} from '@agent/runtime/AgentLaunchContext';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { useRunContext } from '@agent/runtime/RunContext';
import { createRunScope } from '@agent/runtime/RunScope';
import { RUN_OUTCOME, STREAM_PHASE } from '@shared/schemas';

import { createRecordingHost } from '../progressTestUtils';

describe('AgentLaunchContext', () => {
  it('publishes missing-agent banners through the explicit runtime host', async () => {
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

  it('projects model changes into the active run context', async () => {
    const explicit = createRecordingHost();
    const session = {} as SessionHandle;
    const runScope = createRunScope({
      runtimeHost: explicit.host,
      streamId: 'launch-context-stream',
      executionId: 'launch-context-execution',
      agentName: 'chat',
      session,
    });
    const ctx = {
      runScope,
      logger: noopTrace,
      config: {
        agent: runScope.agentName,
        model: 'deepseekT',
      },
    } as unknown as AgentLaunchContext;

    await withExecutionRunContext(
      ctx,
      {
        delegationDepth: 1,
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
        expect(context.delegationDepth).toBe(1);
        expect(context.approvalPromptsUnavailable).toBe(true);
        expect(context.runtimeUnavailableTools).toEqual(['inquiry']);
        expect(context.stopAfterCycle).toBe(true);

        ctx.config.model = 'sonnet46T';

        expect(useRunContext().model).toBe('sonnet46T');
      },
    );
  });

  it('compensates a late launch-assembly failure before trace disposal', async () => {
    const order: string[] = [];
    const failure = new Error('user vars unavailable');
    const session = new SessionHandle();
    const detachEvents = session.events.subscribe(() => undefined);
    const detachStatus = session.status.onDidChange(({ status }) => {
      if (status === STREAM_PHASE.FAILED) order.push('terminal');
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

    mocks.resolve.mockReturnValueOnce({ definitionPath: '/agents/chat.yaml' });
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
          configPayload: {
            agent: 'chat',
            model: 'gpt55',
            agentCategory: AgentCategory.ToolUse,
          },
          runtimeHost: createRecordingHost().host,
          session,
          streamTabIdOverride: 'late-assembly-stream',
          suppressErrorNotification: true,
          modelHandlerCompatibilityKey: 'ModelHandlerOpenAIResponse',
        }),
      ).rejects.toBe(failure);

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
