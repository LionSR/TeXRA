import { describe, expect, it } from 'vitest';

import {
  AgentCategory,
  STREAM_STATUS,
  type ActiveChildInfo,
} from '@shared/schemas';
import { buildStreamMetadata } from '@shared/streams/streamMetadata';

describe('buildStreamMetadata', () => {
  it('fills backend-owned defaults for a stream state metadata payload', () => {
    expect(buildStreamMetadata({ kind: AgentCategory.Workflow })).toMatchObject(
      {
        kind: AgentCategory.Workflow,
        status: STREAM_STATUS.READY,
        conversationProgress: { conversationTurns: 0, toolCallCount: 0 },
        activeSubagents: [],
        finishedSubagentCount: 0,
        activeProcesses: [],
        finishedProcessCount: 0,
      },
    );
  });

  it('preserves supplied status, progress, child badges, and timestamps', () => {
    const child: ActiveChildInfo = {
      executionId: 'agent-1',
      agentName: 'review',
      status: STREAM_STATUS.RUNNING,
    };

    expect(
      buildStreamMetadata({
        kind: AgentCategory.ToolUse,
        status: STREAM_STATUS.RUNNING,
        lastTimestamp: 123,
        conversationProgress: { conversationTurns: 2, toolCallCount: 5 },
        activeSubagents: [child],
        finishedSubagentCount: 1,
        activeProcesses: [child],
        finishedProcessCount: 3,
      }),
    ).toEqual({
      kind: AgentCategory.ToolUse,
      status: STREAM_STATUS.RUNNING,
      lastTimestamp: 123,
      conversationProgress: { conversationTurns: 2, toolCallCount: 5 },
      activeSubagents: [child],
      finishedSubagentCount: 1,
      activeProcesses: [child],
      finishedProcessCount: 3,
    });
  });
});
