import { describe, expect, it } from 'vitest';

import { attachTranscriptRecorder } from '@transcript/TexraTranscriptRecorder';
import { StreamLogStore } from '@transcript/StreamLogStore';
import { TraceEmitter } from '@agent/trace';
import {
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type StreamTabId,
} from '@shared/schemas';
import { isObject } from '@utils/core';

describe('attachTranscriptRecorder stage kind (issue #7267)', () => {
  it("preserves a round stage's kind onto its persisted GROUP_END row", () => {
    const trace = new TraceEmitter();
    const store = new StreamLogStore();
    const streamId = 'stream:kind-preserved' as StreamTabId;
    store.ensureStream(streamId);
    attachTranscriptRecorder(trace, streamId, store);

    const round = trace.openStage('r0', { kind: 'round', index: 0 });
    round.end();

    const entries = store.get(streamId)?.getRange(0) ?? [];
    const roundEntry = entries.find((e) => e.id === round.id);

    expect(roundEntry?.type).toBe(STREAM_LOG_ENTRY_TYPES.GROUP_END);
    expect(isObject(roundEntry?.data) && roundEntry.data.kind).toBe('round');
  });

  it("preserves the root run stage's kind onto its persisted GROUP_END row", () => {
    const trace = new TraceEmitter();
    const store = new StreamLogStore();
    const streamId = 'stream:run-kind-preserved' as StreamTabId;
    store.ensureStream(streamId);
    attachTranscriptRecorder(trace, streamId, store);

    const runStage = trace.openStage('Run: agent', { kind: 'run' });
    runStage.end();

    const entries = store.get(streamId)?.getRange(0) ?? [];
    const runEntry = entries.find((e) => e.id === runStage.id);

    expect(runEntry?.type).toBe(STREAM_LOG_ENTRY_TYPES.GROUP_END);
    expect(isObject(runEntry?.data) && runEntry.data.kind).toBe('run');
  });
});

describe('attachTranscriptRecorder response.finalized (issue #7086)', () => {
  it('upserts the round MODEL_RESPONSE stream entry to the authoritative text', () => {
    const trace = new TraceEmitter();
    const store = new StreamLogStore();
    const streamId = 'stream:upsert' as StreamTabId;
    store.ensureStream(streamId);
    attachTranscriptRecorder(trace, streamId, store);

    // The round's own stream writes raw provider text in real time...
    const output = trace.openStream(MESSAGE_TYPES.MODEL_RESPONSE);
    output.append('Done ✓');
    output.finalize();
    // ...then the flow boundary emits the authoritative, replacement-clean
    // text once `assembly.lastResponse` is set.
    trace.responseFinalized('Done \\checkmark');

    const entries = store.get(streamId)?.getRange(0) ?? [];
    const modelResponseEntries = entries.filter(
      (e) => e.messageType === MESSAGE_TYPES.MODEL_RESPONSE,
    );
    expect(modelResponseEntries).toHaveLength(1);
    expect(modelResponseEntries[0]?.id).toBe(output.id);
    expect(modelResponseEntries[0]?.text).toBe('Done \\checkmark');
  });

  it('appends a fresh MODEL_RESPONSE entry when the round never streamed', () => {
    const trace = new TraceEmitter();
    const store = new StreamLogStore();
    const streamId = 'stream:append' as StreamTabId;
    store.ensureStream(streamId);
    attachTranscriptRecorder(trace, streamId, store);

    trace.responseFinalized('The answer is 2.');

    const entries = store.get(streamId)?.getRange(0) ?? [];
    const modelResponseEntries = entries.filter(
      (e) => e.messageType === MESSAGE_TYPES.MODEL_RESPONSE,
    );
    expect(modelResponseEntries).toHaveLength(1);
    expect(modelResponseEntries[0]?.text).toBe('The answer is 2.');
  });

  it('does not let an earlier round leak its stream id into a later round', () => {
    const trace = new TraceEmitter();
    const store = new StreamLogStore();
    const streamId = 'stream:round-reset' as StreamTabId;
    store.ensureStream(streamId);
    attachTranscriptRecorder(trace, streamId, store);

    const round0 = trace.openStage('r0', { kind: 'round', index: 0 });
    const output = trace.openStream(MESSAGE_TYPES.MODEL_RESPONSE);
    output.append('Let me check that.');
    output.finalize();
    round0.end();

    // Round 1 never opens its own stream (e.g. a non-streaming provider
    // call) — its `response.finalized` must append a new entry, not
    // overwrite round 0's already-closed stream entry.
    const round1 = trace.openStage('r1', { kind: 'round', index: 1 });
    trace.responseFinalized('Final answer.');
    round1.end();

    const entries = store.get(streamId)?.getRange(0) ?? [];
    const modelResponseEntries = entries.filter(
      (e) => e.messageType === MESSAGE_TYPES.MODEL_RESPONSE,
    );
    expect(modelResponseEntries.map((e) => e.text)).toEqual([
      'Let me check that.',
      'Final answer.',
    ]);
    expect(modelResponseEntries[0]?.id).toBe(output.id);
    expect(modelResponseEntries[1]?.id).not.toBe(output.id);
  });

  it('ignores an empty finalized response', () => {
    const trace = new TraceEmitter();
    const store = new StreamLogStore();
    const streamId = 'stream:empty' as StreamTabId;
    store.ensureStream(streamId);
    attachTranscriptRecorder(trace, streamId, store);

    trace.responseFinalized('');

    const entries = store.get(streamId)?.getRange(0) ?? [];
    expect(entries).toHaveLength(0);
  });
});
