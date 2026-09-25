import { describe, expect, it } from 'vitest';

import {
  MESSAGE_TYPES,
  type CompactionActivityData,
  type MessageType,
  type TranscriptEvent,
} from '@shared/schemas';
import {
  applyCompactionActivityEvent,
  createCompactionActivityProjection,
  settleCompactionActivities,
  type CompactionActivityProjection,
} from '@shared/runs/compactionActivityProjection';

/** One event at the row position it wrote, on a clock of ten per position. */
interface Positioned {
  readonly event: TranscriptEvent;
  readonly position: number;
}

/** Feed events to the production reducer in source order, as the fold does. */
function apply(
  projection: CompactionActivityProjection,
  events: readonly Positioned[],
): CompactionActivityProjection {
  for (const { event, position } of events) {
    applyCompactionActivityEvent(projection, event, position, position * 10);
  }
  return projection;
}

/** Test-local full replay through the production reducer (the resync path). */
function projectCompactionActivities(
  events: readonly Positioned[],
): CompactionActivityProjection {
  return apply(createCompactionActivityProjection(), events);
}

function logAt(
  position: number,
  messageType: MessageType,
  data?: unknown,
): Positioned {
  return {
    position,
    event: {
      type: 'log',
      level: 'info',
      message: 'advanced',
      messageType,
      data,
    },
  };
}

function activityEntry(
  seqNo: number,
  operationId: string,
  state: CompactionActivityData['state'],
): Positioned {
  return logAt(seqNo, MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY, {
    activity: 'context_compaction',
    operationId,
    state,
  });
}

function advancingEntry(
  seqNo: number,
  messageType: MessageType = MESSAGE_TYPES.MODEL_RESPONSE,
): Positioned {
  return logAt(seqNo, messageType);
}

describe('compaction activity projection', () => {
  it('carries the freed figures on the running block', () => {
    const projection = projectCompactionActivities([
      activityEntry(2, 'a', 'started'),
      logAt(3, MESSAGE_TYPES.CONTEXT_MANAGEMENT, {
        action: 'compaction',
        tokensBefore: 50_000,
        tokensAfter: 9_000,
        contextWindow: 64_000,
        utilizationBefore: 78.1,
        utilizationAfter: 14.1,
      }),
      activityEntry(4, 'a', 'completed'),
    ]);

    expect(projection.blocks[0]).toMatchObject({
      status: 'completed',
      freed: {
        tokens: 41_000,
        utilizationBefore: 78.1,
        utilizationAfter: 14.1,
      },
    });
  });

  it('handles overlap, out-of-order completion, and duplicate events', () => {
    const projection = projectCompactionActivities([
      activityEntry(1, 'a', 'started'),
      activityEntry(2, 'a', 'started'),
      activityEntry(3, 'b', 'started'),
      activityEntry(4, 'b', 'completed'),
      activityEntry(5, 'a', 'failed'),
      activityEntry(6, 'a', 'cancelled'),
    ]);

    expect(
      projection.blocks.map(({ operationId, status }) => [operationId, status]),
    ).toEqual([
      ['a', 'failed'],
      ['b', 'completed'],
    ]);
  });

  it('ignores orphan terminal records', () => {
    expect(
      projectCompactionActivities([activityEntry(1, 'orphan', 'completed')])
        .blocks,
    ).toEqual([]);
  });

  it('keeps compaction active while the same response starts streaming text', () => {
    const projection = projectCompactionActivities([
      activityEntry(1, 'live', 'started'),
      advancingEntry(2),
    ]);
    expect(projection.blocks[0]?.status).toBe('running');

    apply(projection, [activityEntry(3, 'live', 'completed')]);
    expect(projection.blocks[0]).toMatchObject({
      status: 'completed',
      finishedAt: 30,
    });
  });

  it('interrupts unmatched starts only after meaningful later activity', () => {
    const projection = projectCompactionActivities([
      advancingEntry(1),
      activityEntry(2, 'live', 'started'),
      advancingEntry(3, MESSAGE_TYPES.INTERNAL),
    ]);
    expect(projection.blocks[0]?.status).toBe('running');

    apply(projection, [advancingEntry(4, MESSAGE_TYPES.USER_MESSAGE)]);
    expect(projection.blocks[0]).toMatchObject({
      status: 'interrupted',
      finalized: false,
      finishedAt: 40,
    });

    apply(projection, [activityEntry(5, 'live', 'completed')]);
    expect(projection.blocks[0]).toMatchObject({
      status: 'completed',
      finalized: true,
      finishedAt: 50,
    });
  });

  it("compares a tool event at its row's first-seen position", () => {
    const tool = (type: 'tool.start' | 'tool.end'): TranscriptEvent =>
      type === 'tool.start'
        ? { type, logId: 't', toolName: 'bash', input: {} }
        : { type, logId: 't', status: 'completed' };
    // Started before the compaction and ended after it: not an interruption.
    const projection = projectCompactionActivities([
      { event: tool('tool.start'), position: 1 },
      activityEntry(2, 'live', 'started'),
      { event: tool('tool.end'), position: 1 },
    ]);
    expect(projection.blocks[0]?.status).toBe('running');

    apply(projection, [{ event: tool('tool.start'), position: 3 }]);
    expect(projection.blocks[0]?.status).toBe('interrupted');
  });

  it('finalizes unmatched activity for terminal hydration', () => {
    const projection = projectCompactionActivities([
      activityEntry(1, 'late', 'started'),
      advancingEntry(2, MESSAGE_TYPES.USER_MESSAGE),
    ]);
    expect(projection.blocks[0]).toMatchObject({
      status: 'interrupted',
      finalized: false,
      finishedAt: 20,
    });

    settleCompactionActivities(projection, 25);
    expect(projection.blocks[0]).toMatchObject({
      status: 'interrupted',
      finalized: true,
      finishedAt: 20,
    });

    apply(projection, [activityEntry(4, 'late', 'completed')]);
    expect(projection.blocks[0]?.status).toBe('interrupted');
  });
});
