import { describe, expect, it, vi } from 'vitest';

import { TraceEmitter, type StatusEvent } from '@agent/trace';
import {
  MESSAGE_TYPES,
  RUN_OUTCOME,
  STREAM_LOG_ENTRY_TYPES,
  RUN_PHASE,
  TOOL_USE_STATUS,
  ToolUseLogSchema,
  type StreamLogEntry,
  type RunId,
  type TaskGroup,
} from '@shared/schemas';
import { RUN_TRANSITION_CAUSE } from '@shared/runs/runStatus';
import { upsertTaskGroupFromStreamLog } from '@shared/runs/taskGroupProjection';
import { StreamLog } from '@shared/session/traceEntries';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  createTempDirPlatform,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import { attachTestTranscriptFold } from '@test/support/sessionTestUtils';
import { isObject } from '@utils/core';

/** A recorder attached to a fresh ephemeral store, plus its persisted rows. */
function attachRecorder(runId: RunId = 'stream:test' as RunId): {
  trace: TraceEmitter;
  handleStatus: (event: StatusEvent) => void;
  rows: () => StreamLogEntry[];
  row: (id: string | undefined) => StreamLogEntry | undefined;
} {
  const trace = new TraceEmitter();
  const store = new StreamLog();

  const recorder = attachTestTranscriptFold(trace, runId, store);
  const rows = (): StreamLogEntry[] => store.getRange(0);
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

describe('attachTestTranscriptFold RunPhase-native group rows (issue #7993)', () => {
  it("writes GROUP_START's data.status as RunPhase.RUNNING", () => {
    const { trace, row } = attachRecorder();

    const stage = trace.openStage('r0', { kind: 'round' });

    const startEntry = row(stage.id);

    expect(startEntry?.type).toBe(STREAM_LOG_ENTRY_TYPES.GROUP_START);
    expect(dataOf(startEntry).status).toBe(RUN_PHASE.RUNNING);
  });

  it('defaults GROUP_END to the literal RunOutcome.COMPLETED', () => {
    const { trace, row } = attachRecorder();

    const stage = trace.openStage('r0', { kind: 'round' });
    stage.end();

    const endEntry = row(stage.id);

    expect(endEntry?.type).toBe(STREAM_LOG_ENTRY_TYPES.GROUP_END);
    expect(dataOf(endEntry).status).toBe(RUN_OUTCOME.COMPLETED);
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

describe('attachTestTranscriptFold stage kind (issue #7267)', () => {
  it("preserves a round stage's kind onto its persisted GROUP_END row", () => {
    const { trace, row } = attachRecorder();

    const round = trace.openStage('r0', { kind: 'round', index: 0 });
    round.end();

    const roundEntry = row(round.id);

    expect(roundEntry?.type).toBe(STREAM_LOG_ENTRY_TYPES.GROUP_END);
    expect(dataOf(roundEntry).kind).toBe('round');
  });

  it('persists and projects phase attempt ownership through stage end', () => {
    const { trace, row } = attachRecorder();
    trace.emit({
      type: 'workflow.plan',
      attemptId: 'attempt-2',
      phases: [{ title: 'Review' }],
      tasks: [],
    });

    const phase = trace.openStage('Review', {
      kind: 'phase',
      index: 0,
      total: 1,
    });
    phase.end();

    const entry = row(phase.id)!;
    expect(entry).toMatchObject({
      type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
      data: { attemptId: 'attempt-2' },
    });
    const groups: TaskGroup[] = [];
    expect(upsertTaskGroupFromStreamLog(groups, new Map(), entry)).toBe(true);
    expect(groups).toMatchObject([
      { id: phase.id, attemptId: 'attempt-2', status: RUN_PHASE.COMPLETED },
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

    const modelResponseEntries = rows().filter(
      (e) => e.messageType === MESSAGE_TYPES.MODEL_RESPONSE,
    );
    expect(modelResponseEntries).toHaveLength(1);
    expect(modelResponseEntries[0]?.id).toBe(output.id);
    expect(modelResponseEntries[0]?.text).toBe(completedText);
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

  it('does not let an earlier invocation in the same round stage overwrite a later finalized response', () => {
    const { trace, rows } = attachRecorder();

    const round = trace.openStage('r0', { kind: 'round', index: 0 });
    round.run(() => {
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
});

describe('attachTestTranscriptFold workflow task state', () => {
  it('assigns source settlement order before terminal status projection', () => {
    const runId = 'stream:terminal-settlement' as RunId;
    const { trace, handleStatus, row, rows } = attachRecorder(runId);

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
        status: 'planned',
      },
    });

    handleStatus({
      type: 'status',
      runId,
      phase: RUN_PHASE.CANCELLED,
      cause: RUN_TRANSITION_CAUSE.USER_STOP,
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
    // runs/tools. Late provider cleanup cannot mutate a row already made
    // printable in append-only Static scrollback.
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
      text: '',
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
      runId,
      phase: RUN_PHASE.RUNNING,
      previousPhase: RUN_PHASE.CANCELLED,
      cause: RUN_TRANSITION_CAUSE.LIFECYCLE,
    });
    trace.responseFinalized('Fresh turn response');
    const responses = rows().filter(
      (entry) => entry.messageType === MESSAGE_TYPES.MODEL_RESPONSE,
    );
    expect(responses).toMatchObject([
      {
        id: response.id,
        settlementSeqNo: 2,
        text: '',
      },
      {
        settlementSeqNo: 5,
        text: 'Fresh turn response',
      },
    ]);
    expect(responses[1]?.id).not.toBe(response.id);
  });

  it('closes source rows at waiting and accepts fresh rows after resume', () => {
    const runId = 'stream:waiting-settlement' as RunId;
    const { trace, handleStatus, rows } = attachRecorder(runId);

    const waitingResponse = trace.openRun(MESSAGE_TYPES.MODEL_RESPONSE);
    waitingResponse.append('Waiting response');
    trace.toolStart({
      logId: 'tool:waiting',
      toolName: 'read',
      input: { path: 'waiting.tex' },
    });
    handleStatus({
      type: 'status',
      runId,
      phase: RUN_PHASE.WAITING,
      cause: RUN_TRANSITION_CAUSE.WAIT,
    });

    expect(rows()).toMatchObject([
      {
        id: waitingResponse.id,
        settlementSeqNo: 1,
        text: '',
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
      runId,
      phase: RUN_PHASE.RUNNING,
      previousPhase: RUN_PHASE.WAITING,
      cause: RUN_TRANSITION_CAUSE.RESUME,
    });
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
      status: TOOL_USE_STATUS.COMPLETED,
      result: { toolName: 'read', output: 'done' },
    });

    expect(rows()).toMatchObject([
      {
        id: waitingResponse.id,
        settlementSeqNo: 1,
        text: '',
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

describe('attachTestTranscriptFold record-time secret redaction', () => {
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

    const output = trace.openRun(MESSAGE_TYPES.MODEL_RESPONSE);
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

describe('attachTestTranscriptFold active skills', () => {
  const tempDirs = useTempDirs();
  setupPlatform(() => createTempDirPlatform('texra-recorder-', tempDirs));

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

  it('redacts summaries before truncating the recorded projection', async () => {
    const trace = new TraceEmitter();
    const runId = 'stream:skill-redaction' as RunId;
    const store = new StreamLog();

    const recorder = attachTestTranscriptFold(trace, runId, store);
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
    const persisted = store
      .getRange(0)
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
