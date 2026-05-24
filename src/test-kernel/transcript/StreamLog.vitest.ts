import { describe, expect, it } from 'vitest';

import { StreamLog } from '@transcript';
import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
} from '@shared/schemas';

describe('StreamLog', () => {
  it('appends trusted entries while preserving sequence and lookup invariants', () => {
    const log = new StreamLog();

    log.append({
      id: 'run',
      type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
      level: LOG_LEVELS.INFO,
      timestamp: 1,
      text: 'run',
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

    expect(log.head).toBe(5_001);
    expect(log.size).toBe(5_001);
    expect(log.hasRunningGroup).toBe(true);

    const entries = log.getRange(0, log.head);
    expect(entries).toHaveLength(5_001);
    expect(entries[0]?.seqNo).toBe(1);
    expect(entries.at(-1)?.seqNo).toBe(5_001);

    const updated = log.update('message-2500', { text: 'changed' });
    expect(updated?.seqNo).toBe(2_502);

    log.update('run', {
      type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
      data: { status: 'stopped' },
    });
    expect(log.hasRunningGroup).toBe(false);

    expect(log.drainDirtyUpdates().map((entry) => entry.id)).toEqual([
      'run',
      'message-2500',
    ]);
  });
});
