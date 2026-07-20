// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

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
import type { ToolFileAttachment } from '@shared/schemas/toolResult';

describe('checkToolResultTextLimit', () => {
  it('returns null for text within limit', () => {
    const text = 'a'.repeat(1000);
    assert.equal(checkToolResultTextLimit(text), null);
  });

  it('returns null for text exactly at limit', () => {
    const text = 'a'.repeat(MAX_TOOL_RESULT_TEXT_LENGTH);
    assert.equal(checkToolResultTextLimit(text), null);
  });

  it('keeps head and tail with an elision marker for text exceeding limit', () => {
    const head = 'HEAD_MARKER_'.repeat(500); // well over the head budget
    const tail = 'TAIL_MARKER_'.repeat(5000); // well over the tail budget
    const middle = 'x'.repeat(MAX_TOOL_RESULT_TEXT_LENGTH);
    const text = head + middle + tail;

    const result = checkToolResultTextLimit(text);
    assert.ok(result !== null);
    assert.ok(result.includes('Tool result too large'));
    assert.ok(result.includes('characters elided'));
    // Head/tail content survives; the elided middle does not.
    assert.ok(result.startsWith('Tool result too large'));
    assert.ok(
      result.includes(head.slice(0, TOOL_RESULT_TRUNCATION_HEAD_CHARS)),
    );
    assert.ok(result.includes(tail.slice(-TOOL_RESULT_TRUNCATION_TAIL_CHARS)));
    assert.ok(!result.includes('x'.repeat(1000)));
  });

  it('respects custom max length', () => {
    const text = 'a'.repeat(150);
    assert.equal(checkToolResultTextLimit(text, 200), null);
    const error = checkToolResultTextLimit(text, 100);
    assert.ok(error !== null);
    assert.ok(error.includes('Tool result too large'));
    // The whole point of maxLength is to bound context size — the replacement
    // itself must never exceed the requested limit, even though the default
    // head/tail budgets (4,000 / 50,000 chars) are far larger than 100.
    assert.ok(
      error.length <= 100,
      `expected replacement length ${error.length} <= 100`,
    );
  });

  it('bounds the replacement by maxLength even when default head/tail budgets would overshoot it', () => {
    const text = 'a'.repeat(10_000);
    const maxLength = 500;
    const error = checkToolResultTextLimit(text, maxLength);
    assert.ok(error !== null);
    assert.ok(error.length <= maxLength);
  });

  it('always elides a positive count when the head budget alone would cover the whole text', () => {
    // text.length is only slightly over maxLength, and well under the
    // hardcoded head budget (TOOL_RESULT_TRUNCATION_HEAD_CHARS = 4,000) — the
    // near-boundary case where an unscaled head budget would swallow the
    // entire text, leaving a nonsensical "0 characters elided" marker.
    const text = 'a'.repeat(1500);
    const maxLength = 1000;
    const error = checkToolResultTextLimit(text, maxLength);
    assert.ok(error !== null);
    assert.ok(error.length <= maxLength);
    assert.ok(!error.includes('[... 0 characters elided'));
  });
});

describe('formatToolResultAsText', () => {
  it('returns output when present', () => {
    const result = formatToolResultAsText({
      status: 'executed',
      output: 'test output',
    });
    assert.equal(result, 'test output');
  });

  it('returns summary when no output', () => {
    const result = formatToolResultAsText({
      status: 'executed',
      summary: 'test summary',
    });
    assert.equal(result, 'test summary');
  });

  it('returns error when no output', () => {
    const result = formatToolResultAsText({
      status: 'error',
      error: 'test error',
    });
    assert.equal(result, 'test error');
  });

  it('returns OK when all fields empty', () => {
    const result = formatToolResultAsText({ status: 'executed' });
    assert.equal(result, 'OK');
  });

  it('includes user feedback', () => {
    const result = formatToolResultAsText({
      status: 'executed',
      output: 'test',
      userInstruction: 'do this instead',
    });
    assert.ok(result.includes('User feedback: do this instead'));
  });

  it('includes user patch', () => {
    const result = formatToolResultAsText({
      status: 'executed',
      output: 'test',
      userPatch: '+added line',
    });
    assert.ok(result.includes('User modifications:'));
    assert.ok(result.includes('+added line'));
  });

  it('appends attachment summary', () => {
    const result = formatToolResultAsText(
      { status: 'executed', output: 'test' },
      'Attachments: file.pdf',
    );
    assert.ok(result.includes('Attachments: file.pdf'));
  });

  it('keeps head and tail when result exceeds limit, not a discard stub', () => {
    const head = 'HEAD_MARKER_'.repeat(500);
    const tail = 'TAIL_MARKER_'.repeat(5000);
    const largeOutput = head + 'x'.repeat(MAX_TOOL_RESULT_TEXT_LENGTH) + tail;
    const result = formatToolResultAsText({
      status: 'executed',
      output: largeOutput,
    });
    assert.ok(result.includes('Tool result too large'));
    assert.ok(result.includes('characters elided'));
    assert.ok(!result.includes('was not included'));
    assert.ok(result.includes('HEAD_MARKER_'));
    assert.ok(result.includes('TAIL_MARKER_'));
    assert.ok(!result.includes('x'.repeat(1000)));
  });

  it('returns normal result when within limit', () => {
    const normalOutput = 'a'.repeat(1000);
    const result = formatToolResultAsText({
      status: 'executed',
      output: normalOutput,
    });
    assert.equal(result, normalOutput);
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
    assert.ok(result.includes('done'));
    assert.ok(result.includes('chart.png (image/png)'));
  });

  it('omits the summary when the handler cannot process attachments', () => {
    const result = formatToolResultTextWithAttachments(
      { status: 'executed', output: 'done' },
      attachments,
      false,
    );
    assert.equal(result, 'done');
  });

  it('omits the summary when there are no attachments', () => {
    const result = formatToolResultTextWithAttachments(
      { status: 'executed', output: 'done' },
      [],
      true,
    );
    assert.equal(result, 'done');
  });
});

describe('extractToolAttachments', () => {
  it('projects source error payloads', () => {
    const { sanitizedResult } = extractToolAttachments({
      status: 'error',
      error: 'kill failed',
    });

    assert.equal(sanitizedResult.status, 'error');
    assert.equal(sanitizedResult.error, 'kill failed');
    assert.equal(Object.hasOwn(sanitizedResult, 'output'), false);
  });

  it('rejects legacy results without a source status', () => {
    assert.throws(() =>
      extractToolAttachments({
        output: 'done',
      } as never),
    );
  });

  it('rejects raw status values outside the source contract', () => {
    assert.throws(() =>
      extractToolAttachments({
        status: 'completed',
        output: 'done',
      } as never),
    );
  });

  it('projects executed payloads directly from their source status', () => {
    const { sanitizedResult } = extractToolAttachments({
      status: 'executed',
      output: 'done',
    });

    assert.equal(sanitizedResult.status, 'executed');
    assert.equal(sanitizedResult.output, 'done');
  });

  it('rejects executed payloads with error fields', () => {
    assert.throws(() =>
      extractToolAttachments({
        status: 'executed',
        output: 'usable output',
        error: 'secondary warning',
      } as never),
    );
  });

  it('rejects empty source error text', () => {
    assert.throws(() =>
      extractToolAttachments({
        status: 'error',
        error: '',
      } as never),
    );
  });

  it('keeps error summaries out of model payloads', () => {
    const { sanitizedResult } = extractToolAttachments({
      status: 'error',
      error: 'The operation failed before producing output.',
      summary: 'The operation failed before producing output.',
    });

    assert.equal(sanitizedResult.status, 'error');
    assert.equal(
      sanitizedResult.error,
      'The operation failed before producing output.',
    );
    assert.equal(Object.hasOwn(sanitizedResult, 'summary'), false);
  });

  it('rejects error payloads with file attachments', () => {
    assert.throws(() =>
      extractToolAttachments({
        status: 'error',
        error: 'The operation failed.',
        files: [
          {
            path: 'plot.png',
            mimeType: 'image/png',
            base64Data: 'aW1hZ2U=',
          },
        ],
      } as never),
    );
  });
});
