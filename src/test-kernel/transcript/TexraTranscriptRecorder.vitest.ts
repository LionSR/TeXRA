import { describe, expect, it } from 'vitest';

import { TraceEmitter } from '@agent/trace';
import {
  MESSAGE_TYPES,
  RUN_OUTCOME,
  RUN_PHASE,
  TOOL_CALL_STATUS,
  type RunId,
} from '@shared/schemas';
import { attachTestTranscriptFold } from '@test/support/sessionTestUtils';
import type { TranscriptRow } from '@ui/transcript';

/** A fold attached to a fresh trace, plus its rows and groups. */
function attachRecorder(runId: RunId = 'stream:test' as RunId) {
  const trace = new TraceEmitter();
  const recorder = attachTestTranscriptFold(trace, runId);
  const rows = recorder.rows;
  return {
    trace,
    settlePhase: recorder.settlePhase,
    rows,
    row: (id: string | undefined): TranscriptRow | undefined =>
      rows().find((row) => row.id === id),
    group: (id: string | undefined) =>
      recorder.transcript().taskGroups.find((group) => group.id === id),
  };
}

/** The model-response rows' texts. */
function assistantRows(rows: readonly TranscriptRow[]) {
  return rows.flatMap((row) => (row.kind === 'assistant' ? [row] : []));
}

describe('attachTestTranscriptFold RunPhase-native group rows (issue #7993)', () => {
  it('opens a started stage as a RunPhase.RUNNING group', () => {
    const { trace, group } = attachRecorder();

    const stage = trace.openStage('r0', { kind: 'round' });

    expect(group(stage.id)?.status).toBe(RUN_PHASE.RUNNING);
  });

  it('defaults a stage end to the literal RunOutcome.COMPLETED', () => {
    const { trace, group } = attachRecorder();

    const stage = trace.openStage('r0', { kind: 'round' });
    stage.end();

    expect(group(stage.id)?.status).toBe(RUN_OUTCOME.COMPLETED);
  });

  it('records a failed stage end as RunOutcome.FAILED', () => {
    const { trace, group } = attachRecorder();

    const stage = trace.openStage('r0', { kind: 'round' });
    stage.end(RUN_OUTCOME.FAILED);

    expect(group(stage.id)?.status).toBe(RUN_OUTCOME.FAILED);
  });
});

describe('attachTestTranscriptFold stage kind (issue #7267)', () => {
  it("preserves a round stage's kind onto its closed group", () => {
    const { trace, group } = attachRecorder();

    const round = trace.openStage('r0', { kind: 'round', index: 0 });
    round.end();

    expect(group(round.id)).toMatchObject({
      kind: 'round',
      status: RUN_OUTCOME.COMPLETED,
    });
  });
});

describe('attachTestTranscriptFold undecodable compaction payload', () => {
  it('writes an error row naming the diagnostic instead of dropping it', () => {
    const { trace, rows } = attachRecorder();

    trace.info('Compacting context', {
      messageType: MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY,
      data: { activity: 'context_compaction', state: 'started' },
    });

    expect(rows()).toMatchObject([
      {
        kind: 'error',
        level: 'error',
        messageType: MESSAGE_TYPES.ERROR,
        summary: { full: 'Malformed contextCompactionActivity payload' },
        details: [
          { key: 'message', value: expect.stringContaining('operationId') },
        ],
      },
    ]);
  });
});

describe('attachTestTranscriptFold response.finalized (issue #7086)', () => {
  it('upserts the round MODEL_RESPONSE stream entry to the authoritative text', () => {
    const { trace, rows } = attachRecorder();

    // The round's own stream writes raw provider text in real time...
    const output = trace.openRun(MESSAGE_TYPES.MODEL_RESPONSE);
    output.append('Done ✓');
    output.finalize();
    // ...then the flow boundary emits the authoritative, replacement-clean
    // text once `assembly.lastResponse` is set.
    const completedText = 'Done \\checkmark\n'.repeat(4000);
    trace.responseFinalized(completedText);

    const responses = assistantRows(rows());
    expect(responses).toHaveLength(1);
    expect(responses[0]?.id).toBe(output.id);
    expect(responses[0]?.text.full).toBe(completedText);
  });

  it('appends a fresh MODEL_RESPONSE entry when the round never streamed', () => {
    const { trace, rows } = attachRecorder();

    trace.responseFinalized('The answer is 2.');

    const responses = assistantRows(rows());
    expect(responses).toHaveLength(1);
    expect(responses[0]?.text.full).toBe('The answer is 2.');
  });

  it('does not let an earlier round leak its stream id into a later round', () => {
    const { trace, rows } = attachRecorder();

    const round0 = trace.openStage('r0', { kind: 'round', index: 0 });
    const output = trace.openRun(MESSAGE_TYPES.MODEL_RESPONSE);
    output.append('Let me check that.');
    output.finalize();
    round0.end();

    // Round 1 never opens its own stream (e.g. a non-streaming provider
    // call) — its `response.finalized` must append a new entry, not
    // overwrite round 0's already-closed stream entry.
    const round1 = trace.openStage('r1', { kind: 'round', index: 1 });
    trace.responseFinalized('Final answer.');
    round1.end();

    const responses = assistantRows(rows());
    expect(responses.map((row) => row.text.full)).toEqual([
      'Let me check that.',
      'Final answer.',
    ]);
    expect(responses[0]?.id).toBe(output.id);
    expect(responses[1]?.id).not.toBe(output.id);
  });

  it('does not let an earlier invocation in the same round stage overwrite a later finalized response', () => {
    const { trace, rows } = attachRecorder();

    const round = trace.openStage('r0', { kind: 'round', index: 0 });
    const toolRequest = trace.openRun(MESSAGE_TYPES.MODEL_RESPONSE);
    toolRequest.append('I will inspect the file.');
    toolRequest.finalize();

    trace.toolStart({
      logId: 'tool:read',
      toolName: 'read',
      input: { path: 'paper.tex' },
    });
    trace.toolEnd({ logId: 'tool:read', status: 'completed' });

    trace.responseFinalized('The file contains the theorem statement.');
    round.end();

    const responses = assistantRows(rows());
    expect(responses.map((row) => row.text.full)).toEqual([
      'I will inspect the file.',
      'The file contains the theorem statement.',
    ]);
    expect(responses[1]?.id).not.toBe(responses[0]?.id);
  });
});

describe('attachTestTranscriptFold workflow task state', () => {
  it('assigns source settlement order before terminal status projection', () => {
    const runId = 'stream:terminal-settlement' as RunId;
    const { trace, settlePhase, row, rows } = attachRecorder(runId);

    const phase = trace.openStage('Audit', { kind: 'phase' });
    const response = trace.openRun(MESSAGE_TYPES.MODEL_RESPONSE);
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
        status: 'queued',
      },
    });

    settlePhase(RUN_PHASE.CANCELLED);

    // The phase row settled first (1); the response stream, whose text only
    // ever streamed live, settles second (2) and has no row of its own.
    expect(row(phase.id)).toMatchObject({ settlementSeqNo: 1 });
    expect(row(response.id)).toBeUndefined();
    expect(row('tool:pending')).toMatchObject({
      settlementSeqNo: 3,
      log: {
        status: 'failed',
        error: 'The run ended before this tool completed.',
      },
    });
    expect(row('task:planned')).not.toHaveProperty('settlementSeqNo');

    // The terminal status is the authoritative boundary for recorder-owned
    // runs/tools. Late provider cleanup cannot mutate a row already made
    // printable in append-only Static scrollback.
    trace.emit({
      type: 'stream.end',
      id: response.id,
      finalText: 'Late replacement',
    });
    trace.toolEnd({
      logId: 'tool:pending',
      status: TOOL_CALL_STATUS.COMPLETED,
      result: { toolName: 'read', output: 'late result' },
    });
    expect(row(response.id)).toBeUndefined();
    expect(row('tool:pending')).toMatchObject({
      settlementSeqNo: 3,
      log: {
        status: 'failed',
        error: 'The run ended before this tool completed.',
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
      call: { status: 'skipped', reason: 'not-reached' },
    });

    settlePhase(RUN_PHASE.RUNNING);
    trace.responseFinalized('Fresh turn response');
    const responses = assistantRows(rows());
    expect(responses).toMatchObject([
      { settlementSeqNo: 5, text: { full: 'Fresh turn response' } },
    ]);
    expect(responses[0]?.id).not.toBe(response.id);
  });

  it('closes source rows at waiting and accepts fresh rows after resume', () => {
    const runId = 'stream:waiting-settlement' as RunId;
    const { trace, settlePhase, rows } = attachRecorder(runId);

    const waitingResponse = trace.openRun(MESSAGE_TYPES.MODEL_RESPONSE);
    waitingResponse.append('Waiting response');
    trace.toolStart({
      logId: 'tool:waiting',
      toolName: 'read',
      input: { path: 'waiting.tex' },
    });
    settlePhase(RUN_PHASE.WAITING);

    // The live-only response settles (1) without a row; the card fails (2).
    expect(rows()).toMatchObject([
      {
        id: 'tool:waiting',
        settlementSeqNo: 2,
        toolUse: { status: 'failed' },
      },
    ]);

    settlePhase(RUN_PHASE.RUNNING);
    const resumedResponse = trace.openRun(MESSAGE_TYPES.MODEL_RESPONSE);
    resumedResponse.append('Resumed response');
    resumedResponse.finalize();
    trace.toolStart({
      logId: 'tool:resumed',
      toolName: 'read',
      input: { path: 'resumed.tex' },
    });
    trace.toolEnd({
      logId: 'tool:resumed',
      status: TOOL_CALL_STATUS.COMPLETED,
      result: { toolName: 'read', output: 'done' },
    });

    expect(rows()).toMatchObject([
      {
        id: 'tool:waiting',
        settlementSeqNo: 2,
        toolUse: { status: 'failed' },
      },
      {
        id: resumedResponse.id,
        settlementSeqNo: 3,
        text: { full: 'Resumed response' },
        streaming: false,
      },
      {
        id: 'tool:resumed',
        settlementSeqNo: 4,
        toolUse: { status: 'completed' },
      },
    ]);
    expect(waitingResponse.id).not.toBe(resumedResponse.id);
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
        status: 'queued',
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
        costUsd: 0.03,
      },
    });

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      id: 'task-card',
      kind: 'workflowTask',
      level: 'info',
      groupId: 'phase-audit',
      messageType: MESSAGE_TYPES.WORKFLOW_TASK,
      call: {
        label: 'Audit core',
        status: 'completed',
        durationMs: 12_000,
        costUsd: 0.03,
      },
    });
  });
});
