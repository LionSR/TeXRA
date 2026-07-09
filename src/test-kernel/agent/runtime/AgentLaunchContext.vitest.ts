// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { noopTrace } from '@agent/trace';
import {
  getAgentPath,
  withExecutionRunContext,
  type AgentLaunchContext,
} from '@agent/runtime/AgentLaunchContext';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { useRunContext } from '@agent/runtime/RunContext';
import { createRunScope } from '@agent/runtime/RunScope';

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
    const session = {} as AgentLaunchContext['session'];
    const runScope = createRunScope({
      runtimeHost: explicit.host,
      streamId: 'launch-context-stream' as AgentLaunchContext['streamId'],
      executionId:
        'launch-context-execution' as AgentLaunchContext['executionId'],
      agentName: 'chat',
      session,
    });
    const ctx = {
      runtimeHost: explicit.host,
      runScope,
      logger: noopTrace,
      streamId: runScope.streamId,
      executionId: runScope.executionId,
      config: {
        agent: runScope.agentName,
        model: 'deepseekT',
      },
      session,
    } as unknown as AgentLaunchContext;

    await withExecutionRunContext(ctx, async () => {
      const context = useRunContext();
      expect(context.model).toBe('deepseekT');
      expect(context.kind).toBe('launch');
      if (context.kind !== 'launch') {
        throw new Error('expected launch context');
      }
      expect(context.runScope).toBe(runScope);

      ctx.config.model = 'sonnet46T';

      expect(useRunContext().model).toBe('sonnet46T');
    });
  });
});
