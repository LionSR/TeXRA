import { describe, expect, it } from 'vitest';

import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
} from '@shared/schemas';
import { StreamLog } from '@transcript';

function logWithMessage(text = ''): StreamLog {
  const log = new StreamLog();
  log.append({
    id: 'message',
    type: STREAM_LOG_ENTRY_TYPES.LOG,
    level: LOG_LEVELS.INFO,
    timestamp: 1,
    text,
    messageType: MESSAGE_TYPES.MODEL_RESPONSE,
  });
  return log;
}

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

    expect(log.getDirtyUpdates().map((entry) => entry.id)).toEqual([
      'run',
      'message-2500',
    ]);
    expect(log.drainDirtyUpdates().map((entry) => entry.id)).toEqual([
      'run',
      'message-2500',
    ]);
    expect(log.getDirtyUpdates()).toEqual([]);
  });

  it('does not mark no-op updates dirty', () => {
    const log = new StreamLog();
    log.append({
      id: 'message',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 1,
      text: 'unchanged',
      messageType: MESSAGE_TYPES.DEFAULT,
    });

    expect(log.update('message', { text: 'unchanged' })).toBeUndefined();
    expect(log.drainDirtyUpdates()).toEqual([]);
  });

  it('tracks text appends separately from whole-entry updates', () => {
    const log = logWithMessage();

    log.appendText('message', 'hello');
    log.appendText('message', ' world');

    expect(log.getRange(0, log.head)[0]?.text).toBe('hello world');
    expect(log.getDirtyUpdates()).toEqual([]);
    expect(log.getDirtyTextDeltas()).toEqual([
      { id: 'message', appendText: 'hello world' },
    ]);
  });

  it('keeps text appended while a delta frame is in flight', () => {
    const log = logWithMessage();

    log.appendText('message', 'hello');
    const inFlight = log.getDirtyTextDeltas();
    log.appendText('message', ' world');
    log.ackDirtyTextDeltas(inFlight);

    expect(log.getDirtyTextDeltas()).toEqual([
      { id: 'message', appendText: ' world' },
    ]);
  });

  it('drops pending text deltas when a full entry replay covers them', () => {
    const log = logWithMessage();

    log.appendText('message', 'hello');
    const [entry] = log.getRange(0, log.head);
    if (!entry) throw new Error('expected delivered entry');
    log.ackDirtyTextDeltas([], [entry]);

    expect(log.getDirtyTextDeltas()).toEqual([]);
  });

  it('keeps only text appended while a full entry replay is in flight', () => {
    const log = logWithMessage('prefix ');

    log.appendText('message', 'hello');
    const [entry] = log.getRange(0, log.head);
    if (!entry) throw new Error('expected delivered entry');
    log.appendText('message', ' world');
    log.ackDirtyTextDeltas([], [entry]);

    expect(log.getDirtyTextDeltas()).toEqual([
      { id: 'message', appendText: ' world' },
    ]);
  });
});
