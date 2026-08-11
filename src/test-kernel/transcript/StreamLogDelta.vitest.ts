// The store-emitted entry-level change feed (#9946): every onChange
// notification carries an immutable StreamLogDelta, drained once and
// multicast — nothing is acked and nothing is destroyed, unlike the webview
// dirty-update machinery. Consumers coalesce bursts with
// StreamLogDeltaBuffer and rebuild from getRange(0) on any discontinuity.

import { describe, expect, it } from 'vitest';

import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type StreamLogEntry,
  type StreamTabId,
} from '@shared/schemas';
import { StreamLogDeltaBuffer, type StreamLogDelta } from '@transcript';
import { StreamLogStore } from '@transcript/StreamLogStore';

import {
  appendTranscriptEntry,
  appendTranscriptText,
  updateTranscriptEntry,
  withTranscriptWriter,
} from '../support/storeTestDrivers';

const STREAM = 'delta-stream' as StreamTabId;

function logRow(
  id: string,
  text: string,
): Parameters<typeof appendTranscriptEntry>[2] {
  return {
    id,
    type: STREAM_LOG_ENTRY_TYPES.LOG,
    level: LOG_LEVELS.INFO,
    timestamp: 1,
    messageType: MESSAGE_TYPES.MODEL_RESPONSE,
    text,
  };
}

function captureDeltas(store: StreamLogStore): StreamLogDelta[] {
  const deltas: StreamLogDelta[] = [];
  store.onChange((streamId, delta) => {
    if (streamId === STREAM) deltas.push(delta);
  });
  return deltas;
}

describe('StreamLogStore delta emission', () => {
  it('emits appended entries, then dirtied entries by value, with a monotonic seq', () => {
    const store = StreamLogStore.ephemeral('delta test');
    const deltas = captureDeltas(store);

    appendTranscriptEntry(store, STREAM, logRow('m1', 'hel'));
    appendTranscriptText(store, STREAM, 'm1', 'lo');
    updateTranscriptEntry(store, STREAM, 'm1', { text: 'hello!' });

    expect(deltas.map((delta) => delta.emissionSeq)).toEqual([1, 2, 3]);
    expect(deltas.map((delta) => delta.reset)).toEqual([false, false, false]);

    expect(deltas[0].appended.map((entry) => entry.text)).toEqual(['hel']);
    expect(deltas[0].dirtied).toEqual([]);

    expect(deltas[1].appended).toEqual([]);
    expect(deltas[1].dirtied.map((entry) => entry.text)).toEqual(['hello']);

    expect(deltas[2].dirtied.map((entry) => entry.text)).toEqual(['hello!']);

    // By value: the captured payloads are the immutable post-mutation entry
    // objects, so later mutations must not rewrite an already-emitted delta.
    expect(deltas[0].appended[0].text).toBe('hel');
    expect(deltas[1].dirtied[0].text).toBe('hello');
  });

  it('coalesces one commit covering several mutations into one delta', () => {
    const store = StreamLogStore.ephemeral('delta test');
    appendTranscriptEntry(store, STREAM, {
      id: 'g1',
      type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
      level: LOG_LEVELS.INFO,
      timestamp: 1,
      text: 'r0',
      data: { status: 'running' },
    });
    appendTranscriptEntry(store, STREAM, {
      id: 't1',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 2,
      messageType: MESSAGE_TYPES.THINKING,
      text: 'thinking',
      data: { status: 'running' },
    });
    const deltas = captureDeltas(store);

    // endRunningGroupsForStreams settles both running rows under a single
    // commit, so one delta carries both dirtied entries in seqNo order.
    void store.endRunningGroupsForStreams([STREAM], 99);

    expect(deltas).toHaveLength(1);
    expect(deltas[0].appended).toEqual([]);
    expect(deltas[0].dirtied.map((entry) => entry.id)).toEqual(['g1', 't1']);
  });

  it('does not emit for a no-op update', () => {
    const store = StreamLogStore.ephemeral('delta test');
    appendTranscriptEntry(store, STREAM, logRow('m1', 'hello'));
    const deltas = captureDeltas(store);

    updateTranscriptEntry(store, STREAM, 'm1', { text: 'hello' });

    expect(deltas).toEqual([]);
  });

  it('reports undrained changes only for mutations that bypassed the store', () => {
    const store = StreamLogStore.ephemeral('delta test');
    appendTranscriptEntry(store, STREAM, logRow('m1', 'hello'));
    const log = store.get(STREAM);
    expect(log?.hasUndrainedChanges).toBe(false);

    log?.append(logRow('direct', 'not via writer'));
    expect(log?.hasUndrainedChanges).toBe(true);

    // The next store-mediated commit drains the direct mutation too.
    withTranscriptWriter(store, STREAM, (writer) =>
      writer.appendText('m1', '!'),
    );
    expect(log?.hasUndrainedChanges).toBe(false);
  });
});

describe('StreamLogDeltaBuffer', () => {
  function entryAt(seqNo: number, id: string, text: string): StreamLogEntry {
    return {
      id,
      seqNo,
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 1,
      messageType: MESSAGE_TYPES.MODEL_RESPONSE,
      text,
    } as StreamLogEntry;
  }

  function delta(
    emissionSeq: number,
    appended: StreamLogEntry[],
    dirtied: StreamLogEntry[] = [],
    reset = false,
  ): StreamLogDelta {
    return { emissionSeq, appended, dirtied, reset };
  }

  it('coalesces a contiguous burst, letting a dirtied value supersede its appended one', () => {
    const buffer = new StreamLogDeltaBuffer(4);
    const first = entryAt(10, 'a', 'v1');
    const superseded = entryAt(10, 'a', 'v2');
    const other = entryAt(3, 'b', 'w2');
    buffer.push(delta(5, [first]));
    buffer.push(delta(6, [], [superseded, other]));

    expect(buffer.baseEmissionSeq).toBe(4);
    expect(buffer.emissionSeq).toBe(6);
    expect(buffer.resyncRequired).toBe(false);
    const drained = buffer.drain();
    expect(drained.appended).toEqual([superseded]);
    expect(drained.dirtied).toEqual([other]);
  });

  it('marks a gap as requiring resync while still tracking the newest seq', () => {
    const buffer = new StreamLogDeltaBuffer(4);
    buffer.push(delta(5, [entryAt(1, 'a', 'x')]));
    buffer.push(delta(7, [entryAt(2, 'b', 'y')]));

    expect(buffer.resyncRequired).toBe(true);
    expect(buffer.emissionSeq).toBe(7);
  });

  it('skips stale emissions at or below the base', () => {
    const buffer = new StreamLogDeltaBuffer(4);
    buffer.push(delta(3, [entryAt(1, 'a', 'x')]));
    buffer.push(delta(4, [entryAt(2, 'b', 'y')]));

    expect(buffer.resyncRequired).toBe(false);
    expect(buffer.drain()).toEqual({ appended: [], dirtied: [] });
  });

  it('treats a reset emission as requiring resync', () => {
    const buffer = new StreamLogDeltaBuffer(4);
    buffer.push(delta(5, [entryAt(1, 'a', 'x')]));
    buffer.push(delta(1, [], [], true));

    expect(buffer.resyncRequired).toBe(true);
  });
});
