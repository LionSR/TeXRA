import { describe, expect, it, vi } from 'vitest';

import { TraceEmitter } from '@agent/trace';
import {
  MESSAGE_TYPES,
  RUN_OUTCOME,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  type StreamTabId,
} from '@shared/schemas';
import { attachTranscriptRecorder } from '@transcript/TexraTranscriptRecorder';
import { StreamLogStore } from '@transcript/StreamLogStore';
import { isObject } from '@utils/core';

describe('attachTranscriptRecorder StreamPhase-native group rows (#7993 step 2)', () => {
  it("writes GROUP_START's data.status as StreamPhase.RUNNING", () => {
    const trace = new TraceEmitter();
    const store = StreamLogStore.ephemeral('test');
    const streamId = 'stream:group-start-native' as StreamTabId;
    store.ensureStream(streamId);
    attachTranscriptRecorder(trace, store.acquireWriter(streamId, streamId));

    const stage = trace.openStage('r0', { kind: 'round' });

    const entries = store.get(streamId)?.getRange(0) ?? [];
    const startEntry = entries.find((e) => e.id === stage.id);

    expect(startEntry?.type).toBe(STREAM_LOG_ENTRY_TYPES.GROUP_START);
    expect(isObject(startEntry?.data) && startEntry.data.status).toBe(
      STREAM_PHASE.RUNNING,
    );
  });

  it('defaults GROUP_END to the literal RunOutcome.COMPLETED, not a folded EndGroupStatus', () => {
    const trace = new TraceEmitter();
    const store = StreamLogStore.ephemeral('test');
    const streamId = 'stream:group-end-default-outcome' as StreamTabId;
    store.ensureStream(streamId);
    attachTranscriptRecorder(trace, store.acquireWriter(streamId, streamId));

    const stage = trace.openStage('r0', { kind: 'round' });
    stage.end();

    const entries = store.get(streamId)?.getRange(0) ?? [];
    const endEntry = entries.find((e) => e.id === stage.id);

    expect(endEntry?.type).toBe(STREAM_LOG_ENTRY_TYPES.GROUP_END);
    expect(isObject(endEntry?.data) && endEntry.data.status).toBe(
      RUN_OUTCOME.COMPLETED,
    );
  });

  it('writes an explicit RunOutcome passed to stage.end() verbatim', () => {
    const trace = new TraceEmitter();
    const store = StreamLogStore.ephemeral('test');
    const streamId = 'stream:group-end-explicit-outcome' as StreamTabId;
    store.ensureStream(streamId);
    attachTranscriptRecorder(trace, store.acquireWriter(streamId, streamId));

    const stage = trace.openStage('r0', { kind: 'round' });
    stage.end(RUN_OUTCOME.CANCELLED);

    const entries = store.get(streamId)?.getRange(0) ?? [];
    const endEntry = entries.find((e) => e.id === stage.id);

    expect(isObject(endEntry?.data) && endEntry.data.status).toBe(
      RUN_OUTCOME.CANCELLED,
    );
  });

  it('defaults a stage.run() failure to RunOutcome.FAILED', async () => {
    const trace = new TraceEmitter();
    const store = StreamLogStore.ephemeral('test');
    const streamId = 'stream:group-end-run-failure' as StreamTabId;
    store.ensureStream(streamId);
    attachTranscriptRecorder(trace, store.acquireWriter(streamId, streamId));

    const stage = trace.openStage('r0', { kind: 'round' });
    await expect(
      stage.run(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const entries = store.get(streamId)?.getRange(0) ?? [];
    const endEntry = entries.find((e) => e.id === stage.id);

    expect(isObject(endEntry?.data) && endEntry.data.status).toBe(
      RUN_OUTCOME.FAILED,
    );
  });
});

describe('attachTranscriptRecorder stage kind (issue #7267)', () => {
  it("preserves a round stage's kind onto its persisted GROUP_END row", () => {
    const trace = new TraceEmitter();
    const store = StreamLogStore.ephemeral('test');
    const streamId = 'stream:kind-preserved' as StreamTabId;
    store.ensureStream(streamId);
    attachTranscriptRecorder(trace, store.acquireWriter(streamId, streamId));

    const round = trace.openStage('r0', { kind: 'round', index: 0 });
    round.end();

    const entries = store.get(streamId)?.getRange(0) ?? [];
    const roundEntry = entries.find((e) => e.id === round.id);

    expect(roundEntry?.type).toBe(STREAM_LOG_ENTRY_TYPES.GROUP_END);
    expect(isObject(roundEntry?.data) && roundEntry.data.kind).toBe('round');
  });

  it("preserves the root run stage's kind onto its persisted GROUP_END row", () => {
    const trace = new TraceEmitter();
    const store = StreamLogStore.ephemeral('test');
    const streamId = 'stream:run-kind-preserved' as StreamTabId;
    store.ensureStream(streamId);
    attachTranscriptRecorder(trace, store.acquireWriter(streamId, streamId));

    const runStage = trace.openStage('Run: agent', { kind: 'run' });
    runStage.end();

    const entries = store.get(streamId)?.getRange(0) ?? [];
    const runEntry = entries.find((e) => e.id === runStage.id);

    expect(runEntry?.type).toBe(STREAM_LOG_ENTRY_TYPES.GROUP_END);
    expect(isObject(runEntry?.data) && runEntry.data.kind).toBe('run');
  });

  it('preserves phase position metadata on the terminal row', () => {
    const trace = new TraceEmitter();
    const store = StreamLogStore.ephemeral('test');
    const streamId = 'stream:phase-position-preserved' as StreamTabId;
    store.ensureStream(streamId);
    attachTranscriptRecorder(trace, store.acquireWriter(streamId, streamId));

    const phase = trace.openStage('Review', {
      kind: 'phase',
      index: 1,
      total: 3,
    });
    phase.end();

    const entry = store
      .get(streamId)
      ?.getRange(0)
      .find((candidate) => candidate.id === phase.id);
    expect(entry).toMatchObject({
      type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
      data: {
        kind: 'phase',
        index: 1,
        total: 3,
      },
    });
  });
});

describe('attachTranscriptRecorder response.finalized (issue #7086)', () => {
  it('upserts the round MODEL_RESPONSE stream entry to the authoritative text', () => {
    const trace = new TraceEmitter();
    const store = StreamLogStore.ephemeral('test');
    const streamId = 'stream:upsert' as StreamTabId;
    store.ensureStream(streamId);
    attachTranscriptRecorder(trace, store.acquireWriter(streamId, streamId));

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
    const store = StreamLogStore.ephemeral('test');
    const streamId = 'stream:append' as StreamTabId;
    store.ensureStream(streamId);
    attachTranscriptRecorder(trace, store.acquireWriter(streamId, streamId));

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
    const store = StreamLogStore.ephemeral('test');
    const streamId = 'stream:round-reset' as StreamTabId;
    store.ensureStream(streamId);
    attachTranscriptRecorder(trace, store.acquireWriter(streamId, streamId));

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

  it('does not let an earlier invocation in the same round stage overwrite a later finalized response', () => {
    const trace = new TraceEmitter();
    const store = StreamLogStore.ephemeral('test');
    const streamId = 'stream:inner-round-reset' as StreamTabId;
    store.ensureStream(streamId);
    attachTranscriptRecorder(trace, store.acquireWriter(streamId, streamId));

    const round = trace.openStage('r0', { kind: 'round', index: 0 });
    round.run(() => {
      const toolRequest = trace.openStream(MESSAGE_TYPES.MODEL_RESPONSE);
      toolRequest.append('I will inspect the file.');
      toolRequest.finalize();

      trace.toolStart({
        logId: 'tool:read',
        toolName: 'read',
        input: { path: 'paper.tex' },
      });
      trace.toolEnd({ logId: 'tool:read', status: 'completed' });

      trace.responseFinalized('The file contains the theorem statement.');
    });
    round.end();

    const entries = store.get(streamId)?.getRange(0) ?? [];
    const modelResponseEntries = entries.filter(
      (e) => e.messageType === MESSAGE_TYPES.MODEL_RESPONSE,
    );
    expect(modelResponseEntries.map((e) => e.text)).toEqual([
      'I will inspect the file.',
      'The file contains the theorem statement.',
    ]);
    expect(modelResponseEntries[1]?.id).not.toBe(modelResponseEntries[0]?.id);
  });

  it('ignores an empty finalized response', () => {
    const trace = new TraceEmitter();
    const store = StreamLogStore.ephemeral('test');
    const streamId = 'stream:empty' as StreamTabId;
    store.ensureStream(streamId);
    attachTranscriptRecorder(trace, store.acquireWriter(streamId, streamId));

    trace.responseFinalized('');

    const entries = store.get(streamId)?.getRange(0) ?? [];
    expect(entries).toHaveLength(0);
  });
});

describe('attachTranscriptRecorder workflow task state', () => {
  it('updates one typed task entry from planned to completed', () => {
    const trace = new TraceEmitter();
    const store = StreamLogStore.ephemeral('test');
    const streamId = 'stream:workflow-task' as StreamTabId;
    store.ensureStream(streamId);
    attachTranscriptRecorder(trace, store.acquireWriter(streamId, streamId));

    trace.emit({
      type: 'workflow.task',
      logId: 'task-card',
      task: {
        id: 'audit-core',
        label: 'Audit core',
        phase: 'Audit',
        status: 'planned',
      },
    });
    trace.emit({
      type: 'workflow.task',
      logId: 'task-card',
      stageId: 'phase-audit',
      task: {
        id: 'audit-core',
        label: 'Audit core',
        phase: 'Audit',
        status: 'completed',
        model: 'gpt56',
        durationMs: 12_000,
        totalCostUsd: 0.03,
      },
    });

    const entries = store.get(streamId)?.getRange(0) ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: 'task-card',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: 'info',
      groupId: 'phase-audit',
      messageType: MESSAGE_TYPES.WORKFLOW_TASK,
      text: 'Audit core',
      data: {
        status: 'completed',
        model: 'gpt56',
        durationMs: 12_000,
        totalCostUsd: 0.03,
      },
    });
  });
});

describe('attachTranscriptRecorder timer failure boundary', () => {
  it('latches a delayed write failure instead of throwing from the timer', () => {
    vi.useFakeTimers();
    const trace = new TraceEmitter();
    const store = StreamLogStore.ephemeral('test');
    const streamId = 'stream:timer-failure' as StreamTabId;
    const writer = store.acquireWriter(streamId, streamId);
    const appendText = writer.appendText.bind(writer);
    const failure = new Error('delayed transcript write failed');
    vi.spyOn(writer, 'appendText')
      .mockImplementationOnce(appendText)
      .mockImplementationOnce(() => {
        throw failure;
      });
    const recorder = attachTranscriptRecorder(trace, writer);

    try {
      const output = trace.openStream(MESSAGE_TYPES.MODEL_RESPONSE);
      output.append('first');
      output.append(' delayed');

      expect(() => vi.advanceTimersByTime(50)).not.toThrow();
      expect(() => recorder.flushPending()).toThrow(failure);
      expect(() => recorder.unsubscribe()).toThrow(failure);
    } finally {
      writer.close();
      vi.useRealTimers();
    }
  });
});
