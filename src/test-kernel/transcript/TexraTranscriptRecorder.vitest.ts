import { describe, expect, it } from 'vitest';

import { MESSAGE_TYPES, type RunId } from '@shared/schemas';
import type { TranscriptRow } from '@shared/transcript/transcriptRow';
import { createTestRunTrace } from '@test/support/sessionTestUtils';

/** The model-response rows' texts. */
function assistantRows(rows: readonly TranscriptRow[]) {
  return rows.flatMap((row) => (row.kind === 'assistant' ? [row] : []));
}

describe('createTestRunTrace undecodable compaction payload', () => {
  it('writes an error row naming the diagnostic instead of dropping it', () => {
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
      'stream:test' as RunId,
    );

    const round = trace.openStage('r0', { kind: 'session' });
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
    round.end();

    const responses = assistantRows(rows());
    expect(responses.map((row) => row.text.full)).toEqual([
      'I will inspect the file.',
      'The file contains the theorem statement.',
    ]);
    expect(responses[1]?.id).not.toBe(responses[0]?.id);
  });
});
