// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Third-party imports

// Local imports - utils
import {
  checkToolResultTextLimit,
  extractToolAttachments,
  formatToolResultAsText,
} from '@agent/modelHandlers/utils/toolAttachmentUtils';
import { MAX_TOOL_RESULT_TEXT_LENGTH } from '@agent/modelHandlers/contextManagementConstants';

describe('checkToolResultTextLimit', () => {
  it('returns null for text within limit', () => {
    const text = 'a'.repeat(1000);
    assert.equal(checkToolResultTextLimit(text), null);
  });

  it('returns null for text exactly at limit', () => {
    const text = 'a'.repeat(MAX_TOOL_RESULT_TEXT_LENGTH);
    assert.equal(checkToolResultTextLimit(text), null);
  });

  it('returns error message for text exceeding limit', () => {
    const text = 'a'.repeat(MAX_TOOL_RESULT_TEXT_LENGTH + 100);
    const result = checkToolResultTextLimit(text);
    assert.ok(result !== null);
    assert.ok(result.includes('Tool result too large'));
    assert.ok(result.includes('exceeded by'));
  });

  it('respects custom max length', () => {
    const text = 'a'.repeat(150);
    assert.equal(checkToolResultTextLimit(text, 200), null);
    const error = checkToolResultTextLimit(text, 100);
    assert.ok(error !== null);
    assert.ok(error.includes('exceeded by 50'));
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

  it('returns error when result exceeds limit', () => {
    const largeOutput = 'a'.repeat(MAX_TOOL_RESULT_TEXT_LENGTH + 100);
    const result = formatToolResultAsText({
      status: 'executed',
      output: largeOutput,
    });
    assert.ok(result.includes('Tool result too large'));
    assert.ok(!result.includes('aaa')); // Should not contain original content
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

describe('extractToolAttachments', () => {
  it('treats isError results with output as error payloads', () => {
    const { sanitizedResult } = extractToolAttachments({
      isError: true,
      output: 'kill failed',
    });

    assert.equal(sanitizedResult.status, 'error');
    assert.equal(sanitizedResult.error, 'kill failed');
    assert.equal(Object.hasOwn(sanitizedResult, 'isError'), false);
    assert.equal(Object.hasOwn(sanitizedResult, 'output'), false);
  });

  it('lets the computed discriminator override raw status fields', () => {
    const { sanitizedResult } = extractToolAttachments({
      status: 'completed',
      output: 'done',
    } as never);

    assert.equal(sanitizedResult.status, 'executed');
    assert.equal(sanitizedResult.output, 'done');
  });

  it('drops error from executed payloads when output takes priority', () => {
    const { sanitizedResult } = extractToolAttachments({
      output: 'usable output',
      error: 'secondary warning',
    });

    assert.equal(sanitizedResult.status, 'executed');
    assert.equal(sanitizedResult.output, 'usable output');
    assert.equal(Object.hasOwn(sanitizedResult, 'error'), false);
  });

  it('uses a non-empty fallback error for empty failing results', () => {
    const { sanitizedResult } = extractToolAttachments({
      isError: true,
      error: '',
    });

    assert.equal(sanitizedResult.status, 'error');
    assert.equal(sanitizedResult.error, 'Tool failed');
  });

  it('uses summary as the error text for summary-only failures', () => {
    const { sanitizedResult } = extractToolAttachments({
      isError: true,
      summary: 'The operation failed before producing output.',
    });

    assert.equal(sanitizedResult.status, 'error');
    assert.equal(
      sanitizedResult.error,
      'The operation failed before producing output.',
    );
    assert.equal(Object.hasOwn(sanitizedResult, 'summary'), false);
  });

  it('keeps extracted attachments out of error payloads', () => {
    const { attachments, sanitizedResult } = extractToolAttachments({
      isError: true,
      error: 'The operation failed.',
      files: [
        {
          path: 'plot.png',
          mimeType: 'image/png',
          base64Data: 'aW1hZ2U=',
        },
      ],
    });

    assert.equal(attachments.length, 1);
    assert.equal(sanitizedResult.status, 'error');
    assert.equal(sanitizedResult.error, 'The operation failed.');
    assert.equal(Object.hasOwn(sanitizedResult, 'files'), false);
  });
});
