import { describe, expect, it } from 'vitest';

import { MESSAGE_TYPES, STREAM_LOG_ENTRY_TYPES } from '@shared/schemas';
import {
  compactionActivityRow,
  elideText,
  isSettledRow,
  projectTranscriptRow,
  transcriptText,
} from '@shared/transcript';

const base = {
  type: STREAM_LOG_ENTRY_TYPES.LOG,
  id: 'a',
  seqNo: 1,
  level: 'info',
  timestamp: 0,
} as const;

describe('projectTranscriptRow', () => {
  it('carries the full typed error field set in display order', () => {
    const row = projectTranscriptRow({
      ...base,
      messageType: MESSAGE_TYPES.ERROR,
      text: 'Request failed',
      data: {
        message: 'HTTP 429',
        userRetryable: true,
        statusCode: 429,
        exhaustionReason: 'chatgpt-subscription',
        provider: 'anthropic',
        rawErrorBody: { type: 'error' },
      },
    });
    expect(row?.kind).toBe('error');
    if (row?.kind !== 'error') throw new Error('bad');
    expect(row.summary.full).toBe('Request failed');
    expect(row.details.map((d) => d.key)).toEqual([
      'message',
      'provider',
      'statusCode',
      'userRetryable',
      'exhaustionReason',
      'rawErrorBody',
    ]);
    expect(row.detailText.lineCount).toBeGreaterThan(5);
    expect(isSettledRow(row, false)).toBe(true);
  });

  it('keeps failed and non-media attachments with a counted summary', () => {
    const row = projectTranscriptRow({
      ...base,
      messageType: MESSAGE_TYPES.FILE_LIST,
      text: 'all',
      data: [
        {
          path: 'a.png',
          ok: true,
          media: { kind: 'image', mimeType: 'image/png', sizeBytes: 12 },
        },
        { path: 'b.tex', ok: false },
      ],
    });
    if (row?.kind !== 'fileList') throw new Error('bad');
    expect(row.summary).toBe('Files (1/2 loaded, 1 not found)');
    expect(row.files).toHaveLength(2);
    expect(row.media).toHaveLength(1);
  });

  it('gives a delegation call typed sections instead of a JSON blob', () => {
    const row = projectTranscriptRow({
      ...base,
      messageType: MESSAGE_TYPES.TOOL_USE,
      text: '',
      data: {
        toolName: 'delegate_agent',
        status: 'in_progress',
        input: {
          agent: 'proof',
          model: 'claude-opus',
          instruction: 'Check lemma 3',
          inputFiles: ['a.tex'],
          extractTikz: true,
        },
      },
    });
    if (row?.kind !== 'tool') throw new Error('bad');
    expect(row.model.headerLabel).toBe('delegate_agent');
    expect(row.model.headerPreview).toBe('proof');
    expect(row.model.sections.map((s) => s.kind)).toEqual([
      'identifier',
      'text',
      'badges',
      'fileGroups',
    ]);
    expect(row.model.showOutput).toBe(false);
    expect(row.model.outputSuppression).toBe('empty');
  });

  it('shows MCP output through the section builder', () => {
    const row = projectTranscriptRow({
      ...base,
      messageType: MESSAGE_TYPES.TOOL_USE,
      text: '',
      data: {
        toolName: 'mcp:fs/read',
        status: 'completed',
        input: { path: '/x' },
        output: { output: 'line1\nline2\nline3' },
      },
    });
    if (row?.kind !== 'tool') throw new Error('bad');
    expect(row.model.headerLabel).toBe('MCP fs/read');
    expect(row.model.sections.at(-1)).toMatchObject({ label: 'Result:' });
    expect(row.model.outputSuppression).toBe('rendered-by-sections');
  });

  it('measures untruncated text and elides only at paint', () => {
    const text = transcriptText('1\n2\n3\n4\n5\n6\n7\n8\n9\n10');
    expect(text.lineCount).toBe(10);
    const elided = elideText(text, { headLines: 2, tailLines: 1 });
    expect(elided.head).toEqual(['1', '2']);
    expect(elided.tail).toEqual(['10']);
    expect(elided.hiddenLines).toBe(7);
  });

  it('states the compaction row id, order key and label once', () => {
    const row = compactionActivityRow({
      operationId: 'op1',
      status: 'running',
      finalized: false,
      startPosition: 4,
      startedAt: 99,
    });
    expect(row.id).toBe('compaction:op1');
    expect(row.label).toBe('Compacting context…');
    expect(isSettledRow(row, true)).toBe(false);
  });

  it('drops the state-only and marker message types', () => {
    expect(
      projectTranscriptRow({
        ...base,
        messageType: MESSAGE_TYPES.INTERNAL,
        text: '',
        data: { kind: 'workflowAttempt', attemptId: 'x' },
      }),
    ).toBeUndefined();
  });

  it('inherits phase counts when a phase closes', () => {
    const start = projectTranscriptRow({
      ...base,
      type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
      text: 'Reduce',
      data: { kind: 'phase', index: 1, total: 3 },
    });
    if (start?.kind !== 'phase') throw new Error('bad');
    expect(start.heading).toBe('Reduce (2/3)');
    const end = projectTranscriptRow(
      {
        ...base,
        type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
        text: 'Reduce',
        data: { kind: 'phase' },
      },
      { previousRow: start },
    );
    if (end?.kind !== 'phase') throw new Error('bad');
    expect(end.heading).toBe('Reduce (2/3)');
  });
});
