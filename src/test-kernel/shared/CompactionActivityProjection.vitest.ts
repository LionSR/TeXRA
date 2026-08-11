import { describe, expect, it } from 'vitest';

import {
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type CompactionActivityData,
  type StreamLogEntry,
} from '@shared/schemas';
import {
  applyCompactionActivityEntries,
  createCompactionActivityProjection,
  projectCompactionActivities,
  settleCompactionActivities,
} from '@shared/streams/compactionActivityProjection';

function activityEntry(
  seqNo: number,
  operationId: string,
  state: CompactionActivityData['state'],
): StreamLogEntry {
  return {
    seqNo,
    id: `event-${seqNo}`,
    type: STREAM_LOG_ENTRY_TYPES.LOG,
    level: 'info',
    timestamp: seqNo * 10,
    messageType: MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY,
    data: { activity: 'context_compaction', operationId, state },
  };
}

function advancingEntry(
  seqNo: number,
  messageType: StreamLogEntry['messageType'] = MESSAGE_TYPES.MODEL_RESPONSE,
): StreamLogEntry {
  return {
    seqNo,
    id: `event-${seqNo}`,
    type: STREAM_LOG_ENTRY_TYPES.LOG,
    level: 'info',
    timestamp: seqNo * 10,
    messageType,
    text: 'advanced',
  };
}

describe('compaction activity projection', () => {
  it('updates one stable block from start to terminal outcome', () => {
    const projection = projectCompactionActivities([
      activityEntry(2, 'a', 'started'),
      activityEntry(4, 'a', 'completed'),
    ]);

    expect(projection.blocks).toEqual([
      {
        operationId: 'a',
        status: 'completed',
        finalized: true,
        startPosition: 2,
        startedAt: 20,
        finishedAt: 40,
      },
    ]);
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

  it('ignores orphan terminals, malformed payloads, and obsolete records', () => {
    const malformed: StreamLogEntry[] = [
      activityEntry(1, 'orphan', 'completed'),
      { ...activityEntry(2, 'bad', 'started'), data: { state: 'started' } },
      { ...activityEntry(3, 'bad', 'started'), data: null },
    ];

    expect(projectCompactionActivities(malformed).blocks).toEqual([]);
  });

  it('matches full replay and incremental application', () => {
    const entries = [
      activityEntry(1, 'a', 'started'),
      activityEntry(2, 'b', 'started'),
      activityEntry(3, 'a', 'completed'),
      activityEntry(4, 'b', 'skipped'),
    ];
    const incremental = createCompactionActivityProjection();
    applyCompactionActivityEntries(incremental, entries.slice(0, 2));
    applyCompactionActivityEntries(incremental, entries.slice(2));

    expect(incremental).toEqual(projectCompactionActivities(entries));
  });

  it('keeps compaction active while the same response starts streaming text', () => {
    const projection = createCompactionActivityProjection();

    applyCompactionActivityEntries(projection, [
      activityEntry(1, 'live', 'started'),
      advancingEntry(2),
    ]);
    expect(projection.blocks[0]?.status).toBe('running');

    applyCompactionActivityEntries(projection, [
      activityEntry(3, 'live', 'completed'),
    ]);
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

    applyCompactionActivityEntries(projection, [
      advancingEntry(4, MESSAGE_TYPES.USER_MESSAGE),
    ]);
    expect(projection.blocks[0]).toMatchObject({
      status: 'interrupted',
      finalized: false,
      finishedAt: 40,
    });

    applyCompactionActivityEntries(projection, [
      activityEntry(5, 'live', 'completed'),
    ]);
    expect(projection.blocks[0]).toMatchObject({
      status: 'completed',
      finalized: true,
      finishedAt: 50,
    });
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

    settleCompactionActivities(projection, { finishedAt: 25 });
    expect(projection.blocks[0]).toMatchObject({
      status: 'interrupted',
      finalized: true,
      finishedAt: 20,
    });

    applyCompactionActivityEntries(projection, [
      activityEntry(4, 'late', 'completed'),
    ]);
    expect(projection.blocks[0]?.status).toBe('interrupted');
  });
});
