import { describe, expect, it } from 'vitest';

import {
  MESSAGE_TYPES,
  RUN_PHASE,
  STREAM_LOG_ENTRY_TYPES,
} from '@shared/schemas';
import { projectTranscriptRow } from '@ui/transcript';

const base = {
  type: STREAM_LOG_ENTRY_TYPES.LOG,
  id: 'a',
  seqNo: 1,
  level: 'info',
  timestamp: 0,
} as const;

describe('projectTranscriptRow', () => {
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

    // A structured output with a field the schema does not know keeps its
    // raw form beside the structured sections, so claiming the sections
    // carry the output stays true and the provider's `result` is shown.
    const partial = projectTranscriptRow({
      ...base,
      messageType: MESSAGE_TYPES.TOOL_USE,
      text: '',
      data: {
        toolName: 'mcp:calc/eval',
        status: 'completed',
        input: { expr: '6*7' },
        output: { status: 'completed', result: '42' },
      },
    });
    if (partial?.kind !== 'tool') throw new Error('bad');
    expect(partial.model.sections.map((section) => section.label)).toEqual([
      'Arguments:',
      'Status:',
      'Result:',
    ]);
    expect(partial.model.sections.at(-1)).toMatchObject({
      text: expect.objectContaining({ full: expect.stringContaining('42') }),
    });
    expect(partial.model.outputSuppression).toBe('rendered-by-sections');

    // The normalized output text is the `output` field alone when one exists,
    // so the section must render the dropped fields, not that text.
    const withOutput = projectTranscriptRow({
      ...base,
      messageType: MESSAGE_TYPES.TOOL_USE,
      text: '',
      data: {
        toolName: 'mcp:calc/eval',
        status: 'completed',
        input: { expr: '6*7' },
        output: { status: 'completed', output: 'stdout', result: '42' },
      },
    });
    if (withOutput?.kind !== 'tool') throw new Error('bad');
    const result = withOutput.model.sections.at(-1);
    expect(result).toMatchObject({ label: 'Result:' });
    expect(result).toMatchObject({
      text: expect.objectContaining({ full: expect.stringContaining('42') }),
    });
    expect(result).toMatchObject({
      text: expect.objectContaining({
        full: expect.stringContaining('stdout'),
      }),
    });

    // Result metadata is the row's to show on its own, never a raw field.
    const failed = projectTranscriptRow({
      ...base,
      messageType: MESSAGE_TYPES.TOOL_USE,
      text: '',
      data: {
        toolName: 'mcp:calc/eval',
        status: 'failed',
        input: { expr: '6*7' },
        output: { status: 'error', error: 'boom', diagnostics: { code: 7 } },
      },
    });
    if (failed?.kind !== 'tool') throw new Error('bad');
    expect(failed.model.sections.map((section) => section.label)).toEqual([
      'Arguments:',
      'Status:',
    ]);
  });

  it('drops the state-only and marker message types', () => {
    expect(
      projectTranscriptRow({
        ...base,
        messageType: MESSAGE_TYPES.INTERNAL,
        text: '',
        data: { kind: 'workflowPlan', attemptId: 'x', phases: [], tasks: [] },
      }),
    ).toBeUndefined();
  });

  it('inherits phase counts when a phase closes', () => {
    const start = projectTranscriptRow({
      ...base,
      type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
      text: 'Reduce',
      messageType: MESSAGE_TYPES.DEFAULT,
      data: { status: RUN_PHASE.RUNNING, kind: 'phase', index: 1, total: 3 },
    });
    if (start?.kind !== 'phase') throw new Error('bad');
    expect(start.heading).toBe('Reduce (2/3)');
    const end = projectTranscriptRow(
      {
        ...base,
        type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
        text: 'Reduce',
        messageType: MESSAGE_TYPES.DEFAULT,
        data: { status: RUN_PHASE.COMPLETED, kind: 'phase' },
      },
      { previousRow: start },
    );
    if (end?.kind !== 'phase') throw new Error('bad');
    expect(end.heading).toBe('Reduce (2/3)');
  });
});
