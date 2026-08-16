import { afterEach, describe, expect, it, vi } from 'vitest';

import { TraceEmitter, type StatusEvent } from '@agent/trace';
import {
  MESSAGE_TYPES,
  RUN_OUTCOME,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  TOOL_USE_STATUS,
  type StreamLogEntry,
  type StreamTabId,
} from '@shared/schemas';
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  cleanupTempDirs,
  createTempDirPlatform,
} from '@test/support/tempDirPlatform';
import { attachTranscriptRecorder } from '@transcript/TexraTranscriptRecorder';
import { StreamLogStore } from '@transcript/StreamLogStore';
import { isObject } from '@utils/core';

/** A recorder attached to a fresh ephemeral store, plus its persisted rows. */
function attachRecorder(streamId: StreamTabId = 'stream:test' as StreamTabId): {
  trace: TraceEmitter;
  handleStatus: (event: StatusEvent) => void;
  rows: () => StreamLogEntry[];
  row: (id: string | undefined) => StreamLogEntry | undefined;
} {
  const trace = new TraceEmitter();
  const store = StreamLogStore.ephemeral('test');
  store.ensureStream(streamId);
  const recorder = attachTranscriptRecorder(
    trace,
    store.acquireWriter(streamId, streamId),
  );
  const rows = (): StreamLogEntry[] => store.get(streamId)?.getRange(0) ?? [];
  return {
    trace,
    handleStatus: recorder.handleStatus,
    rows,
    row: (id) => rows().find((entry) => entry.id === id),
  };
}

/** A persisted row's `data` payload, or {} when the row carries none. */
function dataOf(entry: StreamLogEntry | undefined): Record<string, unknown> {
  return isObject(entry?.data) ? entry.data : {};
}

describe('attachTranscriptRecorder StreamPhase-native group rows (issue #7993)', () => {
  it('persists a workflow attempt before it has tasks or phases', () => {
    const { trace, rows } = attachRecorder();

    trace.emit({ type: 'workflow.attempt', attemptId: 'attempt-empty' });

    expect(rows()).toContainEqual(
      expect.objectContaining({
        id: 'workflow-attempt-attempt-empty',
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        messageType: MESSAGE_TYPES.INTERNAL,
        data: {
          kind: 'workflowAttempt',
          attemptId: 'attempt-empty',
        },
      }),
    );
  });

  it("writes GROUP_START's data.status as StreamPhase.RUNNING", () => {
    const { trace, row } = attachRecorder();

    const stage = trace.openStage('r0', { kind: 'round' });

    const startEntry = row(stage.id);

    expect(startEntry?.type).toBe(STREAM_LOG_ENTRY_TYPES.GROUP_START);
    expect(dataOf(startEntry).status).toBe(STREAM_PHASE.RUNNING);
  });

  it('retains workflow attempt identity when a phase settles', () => {
    const { trace, row } = attachRecorder();

    const stage = trace.openStage('Verify', {
      kind: 'phase',
      attemptId: 'attempt-current',
    });
    expect(dataOf(row(stage.id)).attemptId).toBe('attempt-current');

    stage.end();

    expect(dataOf(row(stage.id)).attemptId).toBe('attempt-current');
  });

  it('defaults GROUP_END to the literal RunOutcome.COMPLETED, not a folded EndGroupStatus', () => {
    const { trace, row } = attachRecorder();

    const stage = trace.openStage('r0', { kind: 'round' });
    stage.end();

    const endEntry = row(stage.id);

    expect(endEntry?.type).toBe(STREAM_LOG_ENTRY_TYPES.GROUP_END);
    expect(endEntry?.settlementSeqNo).toBeDefined();
    expect(dataOf(endEntry).status).toBe(RUN_OUTCOME.COMPLETED);
  });

  it('writes an explicit RunOutcome passed to stage.end() verbatim', () => {
    const { trace, row } = attachRecorder();

    const stage = trace.openStage('r0', { kind: 'round' });
    stage.end(RUN_OUTCOME.CANCELLED);

    const endEntry = row(stage.id);

    expect(dataOf(endEntry).status).toBe(RUN_OUTCOME.CANCELLED);
  });

  it('defaults a stage.run() failure to RunOutcome.FAILED', async () => {
    const { trace, row } = attachRecorder();

    const stage = trace.openStage('r0', { kind: 'round' });
    await expect(
      stage.run(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const endEntry = row(stage.id);

    expect(dataOf(endEntry).status).toBe(RUN_OUTCOME.FAILED);
  });
});

describe('attachTranscriptRecorder stage kind (issue #7267)', () => {
  it("preserves a round stage's kind onto its persisted GROUP_END row", () => {
    const { trace, row } = attachRecorder();

    const round = trace.openStage('r0', { kind: 'round', index: 0 });
    round.end();

    const roundEntry = row(round.id);

    expect(roundEntry?.type).toBe(STREAM_LOG_ENTRY_TYPES.GROUP_END);
    expect(dataOf(roundEntry).kind).toBe('round');
  });

  it("preserves the root run stage's kind onto its persisted GROUP_END row", () => {
    const { trace, row } = attachRecorder();

    const runStage = trace.openStage('Run: agent', { kind: 'run' });
    runStage.end();

    const runEntry = row(runStage.id);

    expect(runEntry?.type).toBe(STREAM_LOG_ENTRY_TYPES.GROUP_END);
    expect(dataOf(runEntry).kind).toBe('run');
  });

  it('preserves phase position metadata on the terminal row', () => {
    const { trace, row } = attachRecorder();

    const phase = trace.openStage('Review', {
      kind: 'phase',
      index: 1,
      total: 3,
    });
    phase.end();

    const entry = row(phase.id);
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
    const { trace, rows } = attachRecorder();

    // The round's own stream writes raw provider text in real time...
    const output = trace.openStream(MESSAGE_TYPES.MODEL_RESPONSE);
    output.append('Done ✓');
    output.finalize();
    // ...then the flow boundary emits the authoritative, replacement-clean
    // text once `assembly.lastResponse` is set.
    trace.responseFinalized('Done \\checkmark');

    const modelResponseEntries = rows().filter(
      (e) => e.messageType === MESSAGE_TYPES.MODEL_RESPONSE,
    );
    expect(modelResponseEntries).toHaveLength(1);
    expect(modelResponseEntries[0]?.id).toBe(output.id);
    expect(modelResponseEntries[0]?.text).toBe('Done ✓');
  });

  it('appends a fresh MODEL_RESPONSE entry when the round never streamed', () => {
    const { trace, rows } = attachRecorder();

    trace.responseFinalized('The answer is 2.');

    const modelResponseEntries = rows().filter(
      (e) => e.messageType === MESSAGE_TYPES.MODEL_RESPONSE,
    );
    expect(modelResponseEntries).toHaveLength(1);
    expect(modelResponseEntries[0]?.text).toBe('The answer is 2.');
  });

  it('does not let an earlier round leak its stream id into a later round', () => {
    const { trace, rows } = attachRecorder();

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

    const modelResponseEntries = rows().filter(
      (e) => e.messageType === MESSAGE_TYPES.MODEL_RESPONSE,
    );
    expect(modelResponseEntries.map((e) => e.text)).toEqual([
      'Let me check that.',
      'Final answer.',
    ]);
    expect(modelResponseEntries[0]?.id).toBe(output.id);
    expect(modelResponseEntries[1]?.id).not.toBe(output.id);
  });

  it('does not let an earlier tool-use turn leak into a later session stage', () => {
    const { trace, rows } = attachRecorder();

    const turn0 = trace.openStage('Tool-use turn', { kind: 'session' });
    const output = trace.openStream(MESSAGE_TYPES.MODEL_RESPONSE);
    output.append('I will inspect the workspace.');
    output.finalize();
    turn0.end();

    const turn1 = trace.openStage('Tool-use turn', { kind: 'session' });
    trace.responseFinalized('The workspace is ready.');
    turn1.end();

    const modelResponseEntries = rows().filter(
      (entry) => entry.messageType === MESSAGE_TYPES.MODEL_RESPONSE,
    );
    expect(modelResponseEntries.map((entry) => entry.text)).toEqual([
      'I will inspect the workspace.',
      'The workspace is ready.',
    ]);
    expect(modelResponseEntries[0]?.id).toBe(output.id);
    expect(modelResponseEntries[1]?.id).not.toBe(output.id);
  });

  it('does not let an earlier invocation in the same round stage overwrite a later finalized response', () => {
    const { trace, rows } = attachRecorder();

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

    const modelResponseEntries = rows().filter(
      (e) => e.messageType === MESSAGE_TYPES.MODEL_RESPONSE,
    );
    expect(modelResponseEntries.map((e) => e.text)).toEqual([
      'I will inspect the file.',
      'The file contains the theorem statement.',
    ]);
    expect(modelResponseEntries[1]?.id).not.toBe(modelResponseEntries[0]?.id);
  });

  it('ignores an empty finalized response', () => {
    const { trace, rows } = attachRecorder();

    trace.responseFinalized('');

    expect(rows()).toHaveLength(0);
  });
});

describe('attachTranscriptRecorder workflow task state', () => {
  it('assigns source settlement order before terminal status projection', () => {
    const streamId = 'stream:terminal-settlement' as StreamTabId;
    const { trace, handleStatus, row, rows } = attachRecorder(streamId);

    const phase = trace.openStage('Audit', { kind: 'phase' });
    const response = trace.openStream(MESSAGE_TYPES.MODEL_RESPONSE);
    response.append('Partial answer');
    trace.toolStart({
      logId: 'tool:pending',
      toolName: 'read',
      input: { path: 'paper.tex' },
    });
    trace.emit({
      type: 'workflow.call',
      logId: 'task:planned',
      call: {
        id: 'planned',
        label: 'Audit later',
        status: 'planned',
      },
    });

    handleStatus({
      type: 'status',
      streamId,
      phase: STREAM_PHASE.CANCELLED,
      cause: STREAM_TRANSITION_CAUSE.USER_STOP,
    });

    expect(row(phase.id)).toMatchObject({
      settlementSeqNo: 1,
    });
    expect(row(response.id)).toMatchObject({
      settlementSeqNo: 2,
      data: { status: 'completed' },
    });
    expect(row('tool:pending')).toMatchObject({
      settlementSeqNo: 3,
      data: {
        status: 'failed',
        error: 'The stream ended before this tool completed.',
        isError: true,
      },
    });
    expect(row('task:planned')).not.toHaveProperty('settlementSeqNo');

    // The terminal status is the authoritative boundary for recorder-owned
    // streams/tools. Late provider cleanup cannot mutate a row already made
    // printable in append-only Static scrollback.
    trace.emit({
      type: 'stream.chunk',
      id: response.id,
      text: ' late text',
    });
    trace.emit({
      type: 'stream.end',
      id: response.id,
      finalText: 'Late replacement',
    });
    trace.toolEnd({
      logId: 'tool:pending',
      status: TOOL_USE_STATUS.COMPLETED,
      result: { toolName: 'read', output: 'late result' },
    });
    expect(row(response.id)).toMatchObject({
      settlementSeqNo: 2,
      text: 'Partial answer',
      data: { status: 'completed' },
    });
    expect(row('tool:pending')).toMatchObject({
      settlementSeqNo: 3,
      data: {
        status: 'failed',
        error: 'The stream ended before this tool completed.',
      },
    });

    trace.emit({
      type: 'workflow.call',
      logId: 'task:planned',
      call: {
        id: 'planned',
        label: 'Audit later',
        status: 'skipped',
        reason: 'not-reached',
      },
    });
    expect(row('task:planned')).toMatchObject({
      settlementSeqNo: 4,
      data: { status: 'skipped', reason: 'not-reached' },
    });

    handleStatus({
      type: 'status',
      streamId,
      phase: STREAM_PHASE.RUNNING,
      previousPhase: STREAM_PHASE.CANCELLED,
      cause: STREAM_TRANSITION_CAUSE.LIFECYCLE,
    });
    trace.responseFinalized('Fresh turn response');
    const responses = rows().filter(
      (entry) => entry.messageType === MESSAGE_TYPES.MODEL_RESPONSE,
    );
    expect(responses).toMatchObject([
      {
        id: response.id,
        settlementSeqNo: 2,
        text: 'Partial answer',
      },
      {
        settlementSeqNo: 5,
        text: 'Fresh turn response',
      },
    ]);
    expect(responses[1]?.id).not.toBe(response.id);
  });

  it('closes source rows at waiting and accepts fresh rows after resume', () => {
    const streamId = 'stream:waiting-settlement' as StreamTabId;
    const { trace, handleStatus, rows } = attachRecorder(streamId);

    const waitingResponse = trace.openStream(MESSAGE_TYPES.MODEL_RESPONSE);
    waitingResponse.append('Waiting response');
    trace.toolStart({
      logId: 'tool:waiting',
      toolName: 'read',
      input: { path: 'waiting.tex' },
    });
    handleStatus({
      type: 'status',
      streamId,
      phase: STREAM_PHASE.WAITING,
      cause: STREAM_TRANSITION_CAUSE.WAIT,
    });

    expect(rows()).toMatchObject([
      {
        id: waitingResponse.id,
        settlementSeqNo: 1,
        text: 'Waiting response',
        data: { status: 'completed' },
      },
      {
        id: 'tool:waiting',
        settlementSeqNo: 2,
        data: { status: 'failed' },
      },
    ]);

    handleStatus({
      type: 'status',
      streamId,
      phase: STREAM_PHASE.RUNNING,
      previousPhase: STREAM_PHASE.WAITING,
      cause: STREAM_TRANSITION_CAUSE.RESUME,
    });
    const resumedResponse = trace.openStream(MESSAGE_TYPES.MODEL_RESPONSE);
    resumedResponse.append('Resumed response');
    resumedResponse.finalize();
    trace.toolStart({
      logId: 'tool:resumed',
      toolName: 'read',
      input: { path: 'resumed.tex' },
    });
    trace.toolEnd({
      logId: 'tool:resumed',
      status: TOOL_USE_STATUS.COMPLETED,
      result: { toolName: 'read', output: 'done' },
    });

    expect(rows()).toMatchObject([
      {
        id: waitingResponse.id,
        settlementSeqNo: 1,
        text: 'Waiting response',
        data: { status: 'completed' },
      },
      {
        id: 'tool:waiting',
        settlementSeqNo: 2,
        data: { status: 'failed' },
      },
      {
        id: resumedResponse.id,
        settlementSeqNo: 3,
        text: 'Resumed response',
        data: { status: 'completed' },
      },
      {
        id: 'tool:resumed',
        settlementSeqNo: 4,
        data: { status: 'completed' },
      },
    ]);
  });

  it('updates one typed task entry from planned to completed', () => {
    const { trace, rows } = attachRecorder();

    trace.emit({
      type: 'workflow.call',
      logId: 'task-card',
      call: {
        id: 'audit-core',
        label: 'Audit core',
        phase: 'Audit',
        status: 'planned',
      },
    });
    trace.emit({
      type: 'workflow.call',
      logId: 'task-card',
      stageId: 'phase-audit',
      call: {
        id: 'audit-core',
        label: 'Audit core',
        phase: 'Audit',
        status: 'completed',
        model: 'gpt56',
        durationMs: 12_000,
        totalCostUsd: 0.03,
      },
    });

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
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

describe('attachTranscriptRecorder record-time secret redaction', () => {
  const API_KEY = 'sk-live1234567890abcdef';

  it('redacts a secret in a plain log row before it is persisted', () => {
    const { trace, rows } = attachRecorder();

    trace.info(`Configured with ${API_KEY}`);

    expect(rows()[0]?.text).toBe('Configured with [redacted]');
  });

  it("redacts an error row's provider detail, not just its summary", () => {
    const { trace, rows } = attachRecorder();

    trace.error(`Request failed for ${API_KEY}`, {
      messageType: MESSAGE_TYPES.ERROR,
      data: {
        message: `401 from https://api.example.com/v1?key=${API_KEY}`,
        statusCode: 401,
      },
    });

    expect(rows()[0]).toMatchObject({
      text: 'Request failed for [redacted]',
      data: {
        message: '401 from https://api.example.com/v1?key=[redacted]',
        statusCode: 401,
      },
    });
  });

  it('redacts a secret split across streamed chunks once the stream settles', () => {
    const { trace, row } = attachRecorder();

    const output = trace.openStream(MESSAGE_TYPES.MODEL_RESPONSE);
    output.append('Use sk-live');
    output.append('1234567890abcdef now');
    output.finalize();

    expect(row(output.id)?.text).toBe('Use [redacted] now');
  });

  it('redacts the authoritative finalized response text', () => {
    const { trace, rows } = attachRecorder();

    trace.responseFinalized(`Set API_KEY=${API_KEY} in your shell.`);

    expect(rows()[0]?.text).toBe('Set API_KEY=[redacted] in your shell.');
  });

  it('redacts a stage label', () => {
    const { trace, row } = attachRecorder();

    const stage = trace.openStage(`Probe ${API_KEY}`, { kind: 'phase' });

    expect(row(stage.id)?.text).toBe('Probe [redacted]');
  });

  it("redacts a failed workflow call's label and provider error", () => {
    const { trace, rows } = attachRecorder();

    trace.emit({
      type: 'workflow.call',
      logId: 'task-card',
      call: {
        id: 'audit-core',
        label: `Audit ${API_KEY}`,
        status: 'failed',
        error: `401 rejected key ${API_KEY}`,
      },
    });

    expect(rows()[0]).toMatchObject({
      text: 'Audit [redacted]',
      data: {
        label: 'Audit [redacted]',
        error: '401 rejected key [redacted]',
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

describe('attachTranscriptRecorder active skills', () => {
  const tempDirs: string[] = [];
  setupPlatform(() => createTempDirPlatform('texra-recorder-', tempDirs));

  afterEach(async () => {
    await cleanupTempDirs(tempDirs);
  });

  it('persists only sanitized summaries and lets the latest empty snapshot clear state', () => {
    const { trace, rows } = attachRecorder();

    trace.emit({
      type: 'skills.snapshot',
      skills: [
        {
          name: 'proof-audit',
          description:
            'Review   proofs from /Users/researcher/private/checklist.md with API_KEY=secret-value.',
          source: 'project',
        },
      ],
    });
    trace.emit({ type: 'skills.snapshot', skills: [] });

    const records = rows().filter(
      (entry) => entry.messageType === MESSAGE_TYPES.ACTIVE_SKILLS,
    );
    expect(records).toHaveLength(2);
    expect(records[0]?.data).toStrictEqual({
      skills: [
        {
          name: 'proof-audit',
          description: 'Details available on activation.',
          source: 'project',
        },
      ],
    });
    expect(JSON.stringify(records[0]?.data)).not.toContain('/Users/researcher');
    expect(JSON.stringify(records[0]?.data)).not.toContain('baseDir');
    expect(JSON.stringify(records[0]?.data)).not.toContain('instructions');
    expect(records.at(-1)?.data).toStrictEqual({ skills: [] });
  });

  it('redacts summaries before truncating the disk projection', async () => {
    const trace = new TraceEmitter();
    const streamId = 'stream:skill-redaction' as StreamTabId;
    const store = await StreamLogStore.open();
    store.ensureStream(streamId);
    const writer = store.acquireWriter(streamId, streamId);
    const recorder = attachTranscriptRecorder(trace, writer);
    const descriptionPrefix = `${'Review credentials carefully. '.padEnd(168, 'a')} `;
    const providerKey = 'sk-proj-redaction-example-1234567890abcdef';

    trace.emit({
      type: 'skills.snapshot',
      skills: [
        {
          name: 'credential-check',
          description: `${descriptionPrefix}${providerKey}`,
          source: 'project',
        },
      ],
    });
    recorder.unsubscribe();
    writer.close();
    await store.flush();

    const reopened = await StreamLogStore.openReadOnlyForStream(streamId);
    await reopened.ensureLoaded(streamId);
    const persisted = reopened
      .get(streamId)
      ?.getRange(0)
      .find((entry) => entry.messageType === MESSAGE_TYPES.ACTIVE_SKILLS)?.data;
    expect(persisted).toStrictEqual({
      skills: [
        {
          name: 'credential-check',
          description: `${descriptionPrefix}[redacted]`,
          source: 'project',
        },
      ],
    });
    expect(JSON.stringify(persisted)).not.toContain('sk-proj-red');
  });

  it('records fallback summaries for ANSI-only and controls-only descriptions', () => {
    const { trace, rows } = attachRecorder();

    trace.emit({
      type: 'skills.snapshot',
      skills: [
        {
          name: 'ansi-only',
          description: '\u001b[31m\u001b[0m',
          source: 'project',
        },
        {
          name: 'controls-only',
          description: '\u0001\u0002\u007f\u009b',
          source: 'project',
        },
      ],
    });

    expect(
      rows().find((entry) => entry.messageType === MESSAGE_TYPES.ACTIVE_SKILLS)
        ?.data,
    ).toStrictEqual({
      skills: [
        {
          name: 'ansi-only',
          description: 'Details available on activation.',
          source: 'project',
        },
        {
          name: 'controls-only',
          description: 'Details available on activation.',
          source: 'project',
        },
      ],
    });
  });
});
