import { strict as assert } from 'assert';

import { convertFencedLatexBlocks } from '@replacement/advanced';

describe('convertFencedLatexBlocks', () => {
  it('converts a basic aligned fence', () => {
    const input = '::: aligned\n&= a + b\\\\\n:::\n';
    const expected = '\\begin{aligned}\n&= a + b\\\\\n\\end{aligned}\n';
    assert.strictEqual(convertFencedLatexBlocks(input), expected);
  });

  it('preserves indentation and converts align*', () => {
    const input = '\n  ::: align*\n  x &= y\\\\\n  :::\n';
    const expected = '\n  \\begin{align*}\n  x &= y\\\\\n  \\end{align*}\n';
    assert.strictEqual(convertFencedLatexBlocks(input), expected);
  });

  it('ignores unknown fences', () => {
    const input = '::: tip\ncontent\n:::\n';
    assert.strictEqual(convertFencedLatexBlocks(input), input);
  });

  it('is idempotent', () => {
    const input = '::: aligned\n&= 0\n:::';
    const once = convertFencedLatexBlocks(input);
    assert.strictEqual(convertFencedLatexBlocks(once), once);
  });
});
