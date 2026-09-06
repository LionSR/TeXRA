// Store notifications carry entry changes drained once for all listeners.

import { describe, expect, it } from 'vitest';

import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type StreamTabId,
} from '@shared/schemas';
import type { StreamLogDelta } from '@shared/session/traceEntries';
import { StreamLogStore } from '@transcript/StreamLogStore';

import {
  appendTranscriptEntry,
  appendTranscriptText,
  updateTranscriptEntry,
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
  it('emits appends by value, text appends as chunks, and updates by value', () => {
    const store = StreamLogStore.ephemeral('delta test');
    const deltas = captureDeltas(store);

    appendTranscriptEntry(store, STREAM, logRow('m1', 'hel'));
    appendTranscriptText(store, STREAM, 'm1', 'lo');
    updateTranscriptEntry(store, STREAM, 'm1', { text: 'hello!' });

    expect(deltas.map((delta) => delta.reset)).toEqual([false, false, false]);

    expect(deltas[0].appended.map((entry) => entry.text)).toEqual(['hel']);
    expect(deltas[0].dirtied).toEqual([]);
    expect(deltas[0].textChunks).toEqual([]);

    // appendText emits a chunk instead of a dirtied entry by value.
    expect(deltas[1].appended).toEqual([]);
    expect(deltas[1].dirtied).toEqual([]);
    expect(deltas[1].textChunks).toEqual([{ id: 'm1', appendText: 'lo' }]);

    expect(deltas[2].dirtied.map((entry) => entry.text)).toEqual(['hello!']);
    expect(deltas[2].textChunks).toEqual([]);

    // By value: the captured payloads are the immutable post-mutation entry
    // objects, so later mutations must not rewrite an already-emitted delta.
    expect(deltas[0].appended[0].text).toBe('hel');
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
});
