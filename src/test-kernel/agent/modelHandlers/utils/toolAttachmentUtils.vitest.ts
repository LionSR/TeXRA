// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - utils
import {
  formatToolResultAsText,
  formatToolResultTextWithAttachments,
} from '@agent/modelHandlers/utils/toolAttachmentUtils';
import { extractToolAttachments } from '@agent/core/tools/toolAttachmentExtraction';
import {
  MAX_TOOL_RESULT_TEXT_LENGTH,
  TOOL_RESULT_TRUNCATION_HEAD_CHARS,
  TOOL_RESULT_TRUNCATION_TAIL_CHARS,
} from '@agent/modelHandlers/contextManagementConstants';
import type { ToolFileAttachment } from '@shared/schemas';

/** Head and tail well over their truncation budgets, with an elidable middle. */
function oversizedText(): { head: string; tail: string; text: string } {
  const head = 'HEAD_MARKER_'.repeat(500);
  const tail = 'TAIL_MARKER_'.repeat(5000);
  return {
    head,
    tail,
    text: head + 'x'.repeat(MAX_TOOL_RESULT_TEXT_LENGTH) + tail,
  };
}

describe('formatToolResultAsText', () => {
  it.each([
    [
      'returns output when present',
      { status: 'executed', output: 'test output' },
      'test output',
    ],
    [
      'returns summary when no output',
      { status: 'executed', summary: 'test summary' },
      'test summary',
    ],
    [
      'returns error when no output',
      { status: 'error', error: 'test error' },
      'test error',
    ],
    ['returns OK when all fields empty', { status: 'executed' }, 'OK'],
  ] as const)('%s', (_scenario, result, expected) => {
    expect(formatToolResultAsText(result)).toBe(expected);
  });

  it('includes user feedback', () => {
    const result = formatToolResultAsText({
      status: 'executed',
      output: 'test',
      userInstruction: 'do this instead',
    });
    expect(result).toContain('User feedback: do this instead');
  });

  it('includes user patch', () => {
    const result = formatToolResultAsText({
      status: 'executed',
      output: 'test',
      userPatch: '+added line',
    });
    expect(result).toContain('User modifications:');
    expect(result).toContain('+added line');
  });

  it('appends attachment summary', () => {
    const result = formatToolResultAsText(
      { status: 'executed', output: 'test' },
      'Attachments: file.pdf',
    );
    expect(result).toContain('Attachments: file.pdf');
  });

  it('keeps head and tail when result exceeds limit, not a discard stub', () => {
    const { text } = oversizedText();
    const result = formatToolResultAsText({
      status: 'executed',
      output: text,
    });
    expect(result).toContain('Tool result too large');
    expect(result).toContain('characters elided');
    expect(result).not.toContain('was not included');
    expect(result).toContain('HEAD_MARKER_');
    expect(result).toContain('TAIL_MARKER_');
    expect(result).not.toContain('x'.repeat(1000));
    expect(result.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_TEXT_LENGTH);
  });

  it('returns normal result when within limit', () => {
    const normalOutput = 'a'.repeat(1000);
    const result = formatToolResultAsText({
      status: 'executed',
      output: normalOutput,
    });
    expect(result).toBe(normalOutput);
  });
});

describe('formatToolResultTextWithAttachments', () => {
  const attachments: ToolFileAttachment[] = [
    { path: 'chart.png', mimeType: 'image/png' },
  ];

  it('appends the attachment summary when the handler can process attachments', () => {
    const result = formatToolResultTextWithAttachments(
      { status: 'executed', output: 'done' },
      attachments,
      true,
    );
    expect(result).toContain('done');
    expect(result).toContain('chart.png (image/png)');
  });

  it('omits the summary when the handler cannot process attachments', () => {
    const result = formatToolResultTextWithAttachments(
      { status: 'executed', output: 'done' },
      attachments,
      false,
    );
    expect(result).toBe('done');
  });

  it('omits the summary when there are no attachments', () => {
    const result = formatToolResultTextWithAttachments(
      { status: 'executed', output: 'done' },
      [],
      true,
    );
    expect(result).toBe('done');
  });
});

describe('extractToolAttachments', () => {
  it('projects source error payloads', () => {
    const { sanitizedResult } = extractToolAttachments({
      status: 'error',
      error: 'kill failed',
    });

    expect(sanitizedResult.status).toBe('error');
    expect(sanitizedResult.error).toBe('kill failed');
    expect(Object.hasOwn(sanitizedResult, 'output')).toBe(false);
  });

  it.each([
    ['legacy results without a source status', { output: 'done' }],
    [
      'raw status values outside the source contract',
      { status: 'completed', output: 'done' },
    ],
    [
      'executed payloads with error fields',
      {
        status: 'executed',
        output: 'usable output',
        error: 'secondary warning',
      },
    ],
    ['empty source error text', { status: 'error', error: '' }],
    [
      'error payloads with file attachments',
      {
        status: 'error',
        error: 'The operation failed.',
        files: [
          {
            path: 'plot.png',
            mimeType: 'image/png',
            base64Data: 'aW1hZ2U=',
          },
        ],
      },
    ],
  ])('rejects %s', (_scenario, payload) => {
    expect(() => extractToolAttachments(payload as never)).toThrow();
  });

  it('projects executed payloads directly from their source status', () => {
    const { sanitizedResult } = extractToolAttachments({
      status: 'executed',
      output: 'done',
    });

    expect(sanitizedResult.status).toBe('executed');
    expect(sanitizedResult.output).toBe('done');
  });

  it('keeps error summaries for human-facing logs', () => {
    const { sanitizedResult } = extractToolAttachments({
      status: 'error',
      error: 'The operation failed before producing output.',
      summary: 'Operation failed.',
    });

    expect(sanitizedResult.status).toBe('error');
    expect(sanitizedResult.error).toBe(
      'The operation failed before producing output.',
    );
    // `summary` is "Brief summary for human-facing logs" on the error
    // variant (see ErrorToolResultSchema) — it must survive sanitization so
    // ToolUseDispatchNode's progress log can surface it, even though
    // formatToolResultAsText never sends it to the model on this variant.
    expect(sanitizedResult.summary).toBe('Operation failed.');
  });

  it('drops editedFiles from executed payloads', () => {
    const { sanitizedResult } = extractToolAttachments({
      status: 'executed',
      output: 'done',
      editedFiles: [
        {
          path: 'paper.tex',
          ok: true,
          source: 'tool',
          sourceDisplay: 'Tool use',
        },
      ],
    } as never);

    expect(sanitizedResult.status).toBe('executed');
    expect(sanitizedResult.output).toBe('done');
    expect(Object.hasOwn(sanitizedResult, 'editedFiles')).toBe(false);
  });

  it('drops editedFiles from error payloads', () => {
    const { sanitizedResult } = extractToolAttachments({
      status: 'error',
      error: 'The operation failed.',
      editedFiles: [
        {
          path: 'paper.tex',
          ok: false,
          source: 'tool',
          sourceDisplay: 'Tool use',
        },
      ],
    } as never);

    expect(sanitizedResult.status).toBe('error');
    expect(Object.hasOwn(sanitizedResult, 'editedFiles')).toBe(false);
  });
});
