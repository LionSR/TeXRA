import { describe, expect, it, vi } from 'vitest';

import { AgentExecutionHandle } from '@agent/runtime/executionRegistry';
import {
  getRuntimeActiveAgentNames,
  getRuntimeActiveExecutionIds,
} from '@agent/runtime/executionQueries';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

function createRecordingHost(): AgentRuntimeHost {
  return {
    emit: vi.fn(),
  };
}

describe('runtime execution queries', () => {
  it('projects active execution ids and agent names without exposing handles', () => {
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

      expect(getRuntimeActiveExecutionIds({ session })).toEqual([executionId]);
      expect(getRuntimeActiveAgentNames({ session })).toEqual(['setup']);
    } finally {
      session.dispose();
    }
  });
});
