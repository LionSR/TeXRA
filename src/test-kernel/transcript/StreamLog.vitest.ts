import { describe, expect, it } from 'vitest';

import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
} from '@shared/schemas';
import { StreamLog } from '@shared/session/traceEntries';

describe('StreamLog', () => {
  it('appends trusted entries while preserving sequence and lookup invariants', () => {
    const log = new StreamLog();

    log.append({
      id: 'run',
      type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
      level: LOG_LEVELS.INFO,
      timestamp: 1,
      text: 'run',
      messageType: MESSAGE_TYPES.DEFAULT,
      data: { status: 'running' },
    });

    for (let i = 0; i < 5_000; i++) {
      log.append({
        id: `message-${i}`,
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: i + 2,
        text: `message ${i}`,
        messageType: MESSAGE_TYPES.DEFAULT,
        groupId: 'run',
      });
    }

    const entries = log.toJSON();
    expect(entries).toHaveLength(5_001);
    expect(entries[0]?.seqNo).toBe(1);
    expect(entries.at(-1)?.seqNo).toBe(5_001);

    // Drain the appends so the update emission below is isolated.
    log.drainEmission();

    const updated = log.update('message-2500', { text: 'changed' });
    expect(updated?.seqNo).toBe(2_502);

    log.update('run', {
      type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
      messageType: MESSAGE_TYPES.DEFAULT,
      data: { status: 'cancelled' },
    });

    const delta = log.drainEmission();
    expect(delta.appended).toEqual([]);
    expect(delta.dirtied.map((entry) => entry.id)).toEqual([
      'run',
      'message-2500',
    ]);
  });

  it('does not emit no-op updates', () => {
    const log = new StreamLog();
    log.append({
      id: 'message',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 1,
      text: 'unchanged',
      messageType: MESSAGE_TYPES.DEFAULT,
    });
    log.drainEmission();

    expect(log.update('message', { text: 'unchanged' })).toBeUndefined();
    const delta = log.drainEmission();
    expect(delta.appended).toEqual([]);
    expect(delta.dirtied).toEqual([]);
  });

  it('assigns one durable settlement order when rows become printable', () => {
    const log = new StreamLog();
    const header = log.appendSettled({
      id: 'phase',
      type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
      level: LOG_LEVELS.INFO,
      timestamp: 1,
      text: 'Audit',
      messageType: MESSAGE_TYPES.DEFAULT,
      data: { status: 'running' },
    });
    log.append({
      id: 'task',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 2,
      messageType: MESSAGE_TYPES.WORKFLOW_TASK,
      text: 'Audit core',
      data: {
        id: 'core',
        label: 'Audit core',
        status: 'running',
      },
    });

    const completed = log.settle('task', {
      data: {
        id: 'core',
        label: 'Audit core',
        status: 'completed',
      },
    });
    const revised = log.settle('task', { text: 'Audit core complete' });

    expect(header.settlementSeqNo).toBe(1);
    expect(completed?.settlementSeqNo).toBe(2);
    expect(revised?.settlementSeqNo).toBe(2);
  });
});
