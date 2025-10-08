// Standard library imports
import { strict as assert } from 'assert';

// Local imports
import { createContinuationMessage } from '@agent/utils/continuationMessage';

describe('continuationMessage.createContinuationMessage', () => {
  it('should create a properly formatted continuation message', () => {
    const endTag = '</response>';
    const prefillTokens = 'last few tokens';
    const result = createContinuationMessage(endTag, prefillTokens);

    assert.ok(result.includes('Your response got cut off'));
    assert.ok(result.includes('Continue responding exactly from where you left off'));
    assert.ok(result.includes(`marked by ${endTag}`));
    assert.ok(result.includes('Avoid repeating yourself and avoid starting over'));
    assert.ok(result.includes(`Start your response at the next token after: "${prefillTokens}"`));
  });

  it('should handle special characters in endTag', () => {
    const endTag = '</response:special>';
    const prefillTokens = 'test tokens';
    const result = createContinuationMessage(endTag, prefillTokens);

    assert.ok(result.includes(`marked by ${endTag}`));
  });

  it('should handle special characters in prefillTokens', () => {
    const endTag = '</response>';
    const prefillTokens = 'tokens with "quotes" and \\backslash';
    const result = createContinuationMessage(endTag, prefillTokens);

    assert.ok(result.includes(`Start your response at the next token after: "${prefillTokens}"`));
  });

  it('should return a non-empty string', () => {
    const result = createContinuationMessage('</end>', 'tokens');

    assert.ok(result.length > 0);
    assert.strictEqual(typeof result, 'string');
  });
});
