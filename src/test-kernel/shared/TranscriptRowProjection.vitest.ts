import { describe, expect, it } from 'vitest';

import { MESSAGE_TYPES, type RunId, type ToolUseLog } from '@shared/schemas';
import { createTestRunTrace } from '@test/support/sessionTestUtils';
import {
  compactionActivityRow,
  elideText,
  isSettledRow,
  logPayloadRow,
  toolRow,
  transcriptText,
  type TranscriptRowBase,
} from '@ui/transcript';

const base: TranscriptRowBase = {
  id: 'a',
  seqNo: 1,
  level: 'info',
  timestamp: 0,
};

const tool = (log: ToolUseLog) => toolRow(base, log, undefined, undefined);

describe('transcript row builders', () => {
  it('carries the full typed error field set in display order', () => {
    const row = logPayloadRow(base, 'Request failed', {
      messageType: MESSAGE_TYPES.ERROR,
      data: {
        message: 'HTTP 429',
        userRetryable: true,
        statusCode: 429,
        classification: { kind: 'chatgpt-subscription' },
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
      'classification',
      'rawErrorBody',
    ]);
    expect(row.detailText.lineCount).toBeGreaterThan(5);
    expect(isSettledRow(row, false)).toBe(true);
  });

  it('keeps failed and non-media attachments with a counted summary', () => {
    const row = logPayloadRow(base, 'all', {
      messageType: MESSAGE_TYPES.FILE_LIST,
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
    const row = tool({
      toolName: 'delegate_agent',
      status: 'in_progress',
      input: {
        agent: 'proof',
        model: 'claude-opus',
        instruction: 'Check lemma 3',
        inputFiles: ['a.tex'],
        extractTikz: true,
      },
    });
    if (row?.kind !== 'tool') throw new Error('bad');
    expect(row.model.headerLabel).toBe('Delegate agent');
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
    const row = tool({
      toolName: 'mcp:fs/read',
      status: 'completed',
      input: { path: '/x' },
      output: { output: 'line1\nline2\nline3' },
    });
    if (row?.kind !== 'tool') throw new Error('bad');
    expect(row.model.headerLabel).toBe('MCP fs/read');
    expect(row.model.sections.at(-1)).toMatchObject({ label: 'Result:' });
    expect(row.model.outputSuppression).toBe('rendered-by-sections');

    // A structured output with a field the schema does not know keeps its
    // raw form beside the structured sections, so claiming the sections
    // carry the output stays true and the provider's `result` is shown.
    const partial = tool({
      toolName: 'mcp:calc/eval',
      status: 'completed',
      input: { expr: '6*7' },
      output: { status: 'completed', result: '42' },
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
    const withOutput = tool({
      toolName: 'mcp:calc/eval',
      status: 'completed',
      input: { expr: '6*7' },
      output: { status: 'completed', output: 'stdout', result: '42' },
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
    const failed = tool({
      toolName: 'mcp:calc/eval',
      status: 'failed',
      input: { expr: '6*7' },
      output: { status: 'error', error: 'boom', diagnostics: { code: 7 } },
    });
    if (failed?.kind !== 'tool') throw new Error('bad');
    expect(failed.model.sections.map((section) => section.label)).toEqual([
      'Arguments:',
      'Status:',
    ]);
  });

  it('drops the state-only and marker message types', () => {
    expect(
      logPayloadRow(base, '', {
        messageType: MESSAGE_TYPES.INTERNAL,
        data: { kind: 'workflowPlan', attemptId: 'x', phases: [], tasks: [] },
      }),
    ).toBeUndefined();
  });

  it('keeps phase counts when a phase closes', () => {
    const runTrace = createTestRunTrace('phase' as RunId);
    const phase = runTrace.trace.openStage('Reduce', {
      kind: 'phase',
      index: 1,
      total: 3,
    });
    const heading = () =>
      runTrace.rows().flatMap((row) => (row.kind === 'phase' ? [row] : []))[0]
        ?.heading;
    expect(heading()).toBe('Reduce (2/3)');
    phase.end();
    expect(heading()).toBe('Reduce (2/3)');
  });
});
