import { describe, expect, it } from 'vitest';

import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type StreamLogEntry,
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

    const dirty = log.getDirtyUpdates();
    expect(dirty.map((entry) => entry.id)).toEqual(['run', 'message-2500']);
    log.ackDirtyUpdates(dirty);
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
    expect(log.getDirtyUpdates()).toEqual([]);
  });

  it('assigns one durable settlement order when rows become printable', () => {
    const log = new StreamLog();
    const header = log.appendSettled({
      id: 'phase',
      type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
      level: LOG_LEVELS.INFO,
      timestamp: 1,
      text: 'Audit',
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
    const restored = new StreamLog(log.getRange(0));
    const later = restored.appendSettled({
      id: 'summary',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 3,
      text: 'Done',
    });

    expect(header.settlementSeqNo).toBe(1);
    expect(completed?.settlementSeqNo).toBe(2);
    expect(revised?.settlementSeqNo).toBe(2);
    expect(later.settlementSeqNo).toBe(3);
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

  it('builds text deltas across the joined prefix and chunk tail', () => {
    const log = logWithMessage();

    log.appendText('message', 'hello');
    // Materialize the joined prefix, then keep streaming unjoined chunks:
    // the delta must be assembled piecewise, not by re-joining the text.
    expect(log.getRange(0, log.head)[0]?.text).toBe('hello');
    log.appendText('message', ' wor');
    log.appendText('message', 'ld');

    expect(log.getDirtyTextDeltas()).toEqual([
      { id: 'message', appendText: 'hello world' },
    ]);

    log.ackDirtyTextDeltas(log.getDirtyTextDeltas());
    log.appendText('message', '!');
    expect(log.getDirtyTextDeltas()).toEqual([
      { id: 'message', appendText: '!' },
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

  it('returns point-in-time text on emitted entries across later appends', () => {
    const log = logWithMessage();

    const first = log.appendText('message', 'hel');
    const second = log.appendText('message', 'lo');
    log.appendText('message', '!');

    // Each emitted entry object keeps the text as of its own mutation, even
    // though the chunks live in one shared accumulator that keeps growing.
    expect(second?.text).toBe('hello');
    expect(first?.text).toBe('hel');
    expect(log.getRange(0, log.head)[0]?.text).toBe('hello!');
  });

  it('keeps materialized text equal to the chunk-join oracle across interleavings', () => {
    // Deterministic LCG so the append/update/settle interleaving corpus is
    // reproducible without a fixture file.
    let seed = 42;
    const rand = (bound: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % bound;
    };

    const log = new StreamLog();
    const oracle = new Map<string, string>();
    const ids: string[] = [];
    const snapshots: Array<{ entry: StreamLogEntry; text: string }> = [];

    for (let step = 0; step < 400; step += 1) {
      const op = rand(10);
      if (op < 2 || ids.length === 0) {
        const id = `row-${ids.length}`;
        ids.push(id);
        log.append({
          id,
          type: STREAM_LOG_ENTRY_TYPES.LOG,
          level: LOG_LEVELS.INFO,
          timestamp: step,
          text: 'seed',
          messageType: MESSAGE_TYPES.MODEL_RESPONSE,
        });
        oracle.set(id, 'seed');
        continue;
      }
      const id = ids[rand(ids.length)];
      if (op < 8) {
        const chunk = `c${step}|`;
        const updated = log.appendText(id, chunk);
        oracle.set(id, `${oracle.get(id) ?? ''}${chunk}`);
        const expected = oracle.get(id);
        if (updated && expected !== undefined) {
          snapshots.push({ entry: updated, text: expected });
        }
      } else if (op === 8) {
        const text = `rewritten-${step}`;
        if (log.update(id, { text })) oracle.set(id, text);
      } else {
        log.settle(id, { data: { status: 'completed', step } });
      }
    }

    for (const entry of log.getRange(0)) {
      expect(entry.text).toBe(oracle.get(entry.id));
    }
    // Emitted entries stay point-in-time even after later chunks landed.
    for (const { entry, text } of snapshots) {
      expect(entry.text).toBe(text);
    }
    // The save path (JSON serialization) sees the same materialized text.
    const persisted = JSON.parse(
      JSON.stringify(log.toPersistedEntries()),
    ) as StreamLogEntry[];
    for (const entry of persisted) {
      expect(entry.text).toBe(oracle.get(entry.id));
    }
  });
});
