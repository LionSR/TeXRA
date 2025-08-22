import { strict as assert } from 'assert';

import { wrapCritiqueInAlign } from '@replacement/advanced';

describe('wrapCritiqueInAlign', () => {
  it('wraps bare critique inside align', () => {
    const input = `\\begin{align}\n\\critique{issue}\n\\end{align}`;
    const expected = `\\begin{align}\n\\intertext{\\critique{issue}}\n\\end{align}`;
    assert.strictEqual(wrapCritiqueInAlign(input), expected);
  });

  it('leaves existing intertext wrapping unchanged', () => {
    const input = `\\begin{align}\n\\intertext{\\critique{note}}\n\\end{align}`;
    assert.strictEqual(wrapCritiqueInAlign(input), input);
  });

  it('does not touch critique outside align', () => {
    const input = `Outside \\critique{remark}`;
    assert.strictEqual(wrapCritiqueInAlign(input), input);
  });
});
