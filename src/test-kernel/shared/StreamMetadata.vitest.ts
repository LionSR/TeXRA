import { describe, expect, it } from 'vitest';

import {
  AgentCategory,
  STREAM_SUBSTATE,
  STREAM_STATUS,
  type ActiveChildInfo,
} from '@shared/schemas';
import { buildStreamMetadata } from '@shared/streams/streamMetadata';

describe('buildStreamMetadata', () => {
  it('fills backend-owned defaults for a stream state metadata payload', () => {
    const metadata = buildStreamMetadata({ kind: AgentCategory.Workflow });

    expect(metadata).toMatchObject({
      kind: AgentCategory.Workflow,
      status: STREAM_STATUS.READY,
      conversationProgress: { toolCallCount: 0 },
      activeSubagents: [],
      finishedSubagentCount: 0,
      activeProcesses: [],
      finishedProcessCount: 0,
    });
    expect(Object.hasOwn(metadata, 'substate')).toBe(true);
    expect(metadata.substate).toBeUndefined();
  });

  it('preserves supplied status, progress, child badges, and timestamps', () => {
    const child: ActiveChildInfo = {
      kind: 'process',
      executionId: 'agent-1',
      agentName: 'review',
      status: STREAM_STATUS.RUNNING,
    };

    expect(
      buildStreamMetadata({
        kind: AgentCategory.ToolUse,
        status: STREAM_STATUS.RUNNING,
        substate: STREAM_SUBSTATE.STARTING,
        lastTimestamp: 123,
        conversationProgress: { toolCallCount: 5 },
        roundStage: { index: 1, total: 3 },
        activeSubagents: [child],
        finishedSubagentCount: 1,
        activeProcesses: [child],
        finishedProcessCount: 3,
      }),
    ).toEqual({
      kind: AgentCategory.ToolUse,
      status: STREAM_STATUS.RUNNING,
      substate: STREAM_SUBSTATE.STARTING,
      lastTimestamp: 123,
      conversationProgress: { toolCallCount: 5 },
      roundStage: { index: 1, total: 3 },
      activeSubagents: [child],
      finishedSubagentCount: 1,
      activeProcesses: [child],
      finishedProcessCount: 3,
    });
  });
});
