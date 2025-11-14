// Node.js built-in imports
import { strict as assert } from 'assert';

// Internal imports
import { wrapCritiqueInAlign } from '@replacement/advanced';

describe('wrapCritiqueInAlign', () => {
  it('wraps bare critique inside align', () => {
    const input = `\\begin{align}\n\\critique{issue}\n\\end{align}`;
    const expected = `\\begin{align}\n\\intertext{\\critique{issue}}\n\\end{align}`;
    assert.strictEqual(wrapCritiqueInAlign(input), expected);
  });

  it('wraps bare critique inside align*', () => {
    const input = `\\begin{align*}\n\\critique{issue}\n\\end{align*}`;
    const expected = `\\begin{align*}\n\\intertext{\\critique{issue}}\n\\end{align*}`;
    assert.strictEqual(wrapCritiqueInAlign(input), expected);
  });

  it('wraps bare comment inside align', () => {
    const input = `\\begin{align}\n\\comment{note}\n\\end{align}`;
    const expected = `\\begin{align}\n\\intertext{\\comment{note}}\n\\end{align}`;
    assert.strictEqual(wrapCritiqueInAlign(input), expected);
  });

  it('wraps multiple critiques in same align block', () => {
    const input = `\\begin{align}\na &= b \\\\n\\critique{first}\nc &= d \\\\n\\critique{second}\n\\end{align}`;
    const expected = `\\begin{align}\na &= b \\\\n\\intertext{\\critique{first}}\nc &= d \\\\n\\intertext{\\critique{second}}\n\\end{align}`;
    assert.strictEqual(wrapCritiqueInAlign(input), expected);
  });

  it('handles nested braces in critique content', () => {
    const input = `\\begin{align}\n\\critique{This is \\textbf{bold}}\n\\end{align}`;
    const expected = `\\begin{align}\n\\intertext{\\critique{This is \\textbf{bold}}}\n\\end{align}`;
    assert.strictEqual(wrapCritiqueInAlign(input), expected);
  });

  it('leaves existing intertext wrapping unchanged', () => {
    const input = `\\begin{align}\n\\intertext{\\critique{note}}\n\\end{align}`;
    assert.strictEqual(wrapCritiqueInAlign(input), input);
  });

  it('is idempotent for comment', () => {
    const input = `\\begin{align}\n\\comment{note}\n\\end{align}`;
    const once = wrapCritiqueInAlign(input);
    assert.strictEqual(wrapCritiqueInAlign(once), once);
  });

  it('does not touch critique outside align', () => {
    const input = `Outside \\critique{remark}`;
    assert.strictEqual(wrapCritiqueInAlign(input), input);
  });
});
