// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - utils
import {
  checkToolResultTextLimit,
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

describe('checkToolResultTextLimit', () => {
  it('returns null for text within limit', () => {
    const text = 'a'.repeat(1000);
    expect(checkToolResultTextLimit(text)).toBeNull();
  });

  it('returns null for text exactly at limit', () => {
    const text = 'a'.repeat(MAX_TOOL_RESULT_TEXT_LENGTH);
    expect(checkToolResultTextLimit(text)).toBeNull();
  });

  it('keeps head and tail with an elision marker for text exceeding limit', () => {
    const { head, tail, text } = oversizedText();

    const result = checkToolResultTextLimit(text);
    expect(result).not.toBeNull();
    const truncated = result!;
    expect(truncated).toContain('Tool result too large');
    expect(truncated).toContain('characters elided');
    // Head/tail content survives; the elided middle does not.
    expect(truncated.startsWith('Tool result too large')).toBe(true);
    expect(truncated).toContain(
      head.slice(0, TOOL_RESULT_TRUNCATION_HEAD_CHARS),
    );
    expect(truncated).toContain(tail.slice(-TOOL_RESULT_TRUNCATION_TAIL_CHARS));
    expect(truncated).not.toContain('x'.repeat(1000));
  });

  it('respects custom max length', () => {
    const text = 'a'.repeat(150);
    expect(checkToolResultTextLimit(text, 200)).toBeNull();
    const error = checkToolResultTextLimit(text, 100);
    expect(error).not.toBeNull();
    const replacement = error!;
    expect(replacement).toContain('Tool result too large');
    // The whole point of maxLength is to bound context size — the replacement
    // itself must never exceed the requested limit, even though the default
    // head/tail budgets (4,000 / 50,000 chars) are far larger than 100.
    expect(replacement.length).toBeLessThanOrEqual(100);
  });

  it('bounds the replacement by maxLength even when default head/tail budgets would overshoot it', () => {
    const text = 'a'.repeat(10_000);
    const maxLength = 500;
    const error = checkToolResultTextLimit(text, maxLength);
    expect(error).not.toBeNull();
    expect(error!.length).toBeLessThanOrEqual(maxLength);
  });

  it('always elides a positive count when the head budget alone would cover the whole text', () => {
    // text.length is only slightly over maxLength, and well under the
    // hardcoded head budget (TOOL_RESULT_TRUNCATION_HEAD_CHARS = 4,000) — the
    // near-boundary case where an unscaled head budget would swallow the
    // entire text, leaving a nonsensical "0 characters elided" marker.
    const text = 'a'.repeat(1500);
    const maxLength = 1000;
    const error = checkToolResultTextLimit(text, maxLength);
    expect(error).not.toBeNull();
    expect(error!.length).toBeLessThanOrEqual(maxLength);
    expect(error!).not.toContain('[... 0 characters elided');
  });
});

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

  it('keeps error summaries out of model payloads', () => {
    const { sanitizedResult } = extractToolAttachments({
      status: 'error',
      error: 'The operation failed before producing output.',
      summary: 'The operation failed before producing output.',
    });

    expect(sanitizedResult.status).toBe('error');
    expect(sanitizedResult.error).toBe(
      'The operation failed before producing output.',
    );
    expect(Object.hasOwn(sanitizedResult, 'summary')).toBe(false);
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
