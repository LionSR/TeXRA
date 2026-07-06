import { describe, expect, it } from 'vitest';

import { attachTranscriptRecorder } from '@transcript/TexraTranscriptRecorder';
import { StreamLogStore } from '@transcript/StreamLogStore';
import { TraceEmitter } from '@agent/trace';
import { STREAM_LOG_ENTRY_TYPES, type StreamTabId } from '@shared/schemas';
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
