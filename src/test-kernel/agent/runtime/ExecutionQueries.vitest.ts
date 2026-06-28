import { describe, expect, it, vi } from 'vitest';

import { AgentExecutionHandle } from '@agent/runtime/executionRegistry';
import { hasRuntimeActiveAgentName } from '@agent/runtime/executionQueries';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

function createRecordingHost(): AgentRuntimeHost {
  return {
    emit: vi.fn(),
  };
}

describe('runtime execution queries', () => {
  it('checks active agent names without exposing handles', () => {
    const session = new SessionHandle();
    const streamId = 'execution-query-stream' as StreamTabId;
    const executionId = 'execution-query-id' as ExecutionId;

    try {
      session.executions.track(
        new AgentExecutionHandle(
          executionId,
          streamId,
          streamId,
          'setup',
          'toolUse',
          createRecordingHost(),
        ),
      );

      expect(hasRuntimeActiveAgentName({ agentName: 'setup', session })).toBe(
        true,
      );
      expect(
        hasRuntimeActiveAgentName({ agentName: 'other-agent', session }),
      ).toBe(false);
    } finally {
      session.dispose();
    }
  });
});
