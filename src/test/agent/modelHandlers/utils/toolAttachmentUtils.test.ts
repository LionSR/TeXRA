// Third-party imports
import { strict as assert } from 'assert';

// Local imports - utils
import {
  checkToolResultTextLimit,
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
    const result = formatToolResultAsText({ output: 'test output' });
    assert.equal(result, 'test output');
  });

  it('returns summary when no output', () => {
    const result = formatToolResultAsText({ summary: 'test summary' });
    assert.equal(result, 'test summary');
  });

  it('returns error when no output', () => {
    const result = formatToolResultAsText({ error: 'test error' });
    assert.equal(result, 'test error');
  });

  it('returns OK when all fields empty', () => {
    const result = formatToolResultAsText({});
    assert.equal(result, 'OK');
  });

  it('includes user feedback', () => {
    const result = formatToolResultAsText({
      output: 'test',
      userInstruction: 'do this instead',
    });
    assert.ok(result.includes('User feedback: do this instead'));
  });

  it('includes user patch', () => {
    const result = formatToolResultAsText({
      output: 'test',
      userPatch: '+added line',
    });
    assert.ok(result.includes('User modifications:'));
    assert.ok(result.includes('+added line'));
  });

  it('appends attachment summary', () => {
    const result = formatToolResultAsText(
      { output: 'test' },
      'Attachments: file.pdf',
    );
    assert.ok(result.includes('Attachments: file.pdf'));
  });

  it('returns error when result exceeds limit', () => {
    const largeOutput = 'a'.repeat(MAX_TOOL_RESULT_TEXT_LENGTH + 100);
    const result = formatToolResultAsText({ output: largeOutput });
    assert.ok(result.includes('Tool result too large'));
    assert.ok(!result.includes('aaa')); // Should not contain original content
  });

  it('returns normal result when within limit', () => {
    const normalOutput = 'a'.repeat(1000);
    const result = formatToolResultAsText({ output: normalOutput });
    assert.equal(result, normalOutput);
  });
});
