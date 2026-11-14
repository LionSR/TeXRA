import { describe, expect, it } from 'vitest';

import {
  emptyRunEndOutput,
  MESSAGE_TYPES,
  type RunId,
} from '@texra-ai/harness/schemas';
import { createTestRunTrace } from '@test/support/sessionTestUtils';
import type { TranscriptRow } from '@texra-ai/harness/transcript';

/** The model-response rows' texts. */
function assistantRows(rows: readonly TranscriptRow[]) {
  return rows.flatMap((row) => (row.kind === 'assistant' ? [row] : []));
}

describe('createTestRunTrace undecodable compaction payload', () => {
  it('writes an error row naming the diagnostic instead of dropping it', () => {
    // cast: a fixture run id; the trace only stamps it on its rows.
    const { trace, rows } = createTestRunTrace('stream:test' as RunId);

    trace.info('Compacting context', {
      messageType: MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY,
      data: { activity: 'context_compaction', state: 'started' },
    });

    expect(rows()).toMatchObject([
      {
        kind: 'error',
        summary: { full: 'Malformed contextCompactionActivity payload' },
        details: [
          { key: 'message', value: expect.stringContaining('operationId') },
        ],
      },
    ]);
  });
});

describe('createTestRunTrace response.finalized (issue #7086)', () => {
  it('does not let an earlier invocation in the same round stage overwrite a later finalized response', () => {
    const { trace, finalize, rows } = createTestRunTrace(
      // cast: a fixture run id; the trace only stamps it on its rows.
      'stream:test' as RunId,
    );

    const toolRequest = trace.openRun(MESSAGE_TYPES.MODEL_RESPONSE);
    toolRequest.append('I will inspect the file.');
    toolRequest.finalize();

    trace.emit({
      type: 'tool.start',
      logId: 'tool:read',
      toolName: 'read',
      input: { path: 'paper.tex' },
    });
    trace.emit({ type: 'tool.end', logId: 'tool:read', status: 'completed' });

    finalize('The file contains the theorem statement.');

    const responses = assistantRows(rows());
    expect(responses.map((row) => row.text.full)).toEqual([
      'I will inspect the file.',
      'The file contains the theorem statement.',
    ]);
    expect(responses[1]?.id).not.toBe(responses[0]?.id);
  });
});

describe('createTestRunTrace script stage across a stop and resume', () => {
  it("reopens the stage when a resumed call's card starts again", () => {
    // cast: a fixture run id; the trace only stamps it on its rows.
    const { trace, lifecycle, transcript } = createTestRunTrace(
      'stream:test' as RunId,
    );
    const call = {
      type: 'tool.start',
      logId: 'call-1',
      stageId: 'script-card',
      toolName: 'agent',
      input: {},
    } as const;
    trace.emit({
      type: 'tool.start',
      logId: 'script-card',
      toolName: 'script',
      input: { code: '', title: 'Map' },
    });
    trace.emit(call);
    lifecycle({
      type: 'run.end',
      outcome: 'cancelled',
      output: emptyRunEndOutput(),
    });
    lifecycle({ type: 'run.activate' });
    // The resumed call keeps its card: its retry starts the same `logId`.
    trace.emit({ ...call, attempt: 2 });

    expect(transcript().stages).toMatchObject([
      { id: 'script-card', name: 'Map', outcome: null },
    ]);
    expect(transcript().stages[0]).not.toHaveProperty('endTime');
    // The card the run's end cut is running again, as its stage is.
    const card = transcript().rows.find((row) => row.id === 'call-1');
    expect(card).toMatchObject({
      toolUse: { status: 'in_progress' },
      attempt: 2,
    });
    expect(card).not.toHaveProperty('cutByRunEnd');
  });
});
