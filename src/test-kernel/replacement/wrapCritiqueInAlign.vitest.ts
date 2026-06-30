// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Node.js built-in imports

// Internal imports
import { wrapCritiqueInAlign } from '@replacement/advanced';

describe('wrapCritiqueInAlign', () => {
  it.each([
    {
      name: 'wraps bare critique inside align',
      input: `\\begin{align}\n\\critique{issue}\n\\end{align}`,
      expected: `\\begin{align}\n\\intertext{\\critique{issue}}\n\\end{align}`,
    },
    {
      name: 'wraps bare critique inside align*',
      input: `\\begin{align*}\n\\critique{issue}\n\\end{align*}`,
      expected: `\\begin{align*}\n\\intertext{\\critique{issue}}\n\\end{align*}`,
    },
    {
      name: 'wraps bare comment inside align',
      input: `\\begin{align}\n\\comment{note}\n\\end{align}`,
      expected: `\\begin{align}\n\\intertext{\\comment{note}}\n\\end{align}`,
    },
    {
      name: 'wraps multiple critiques in same align block',
      input: `\\begin{align}\na &= b \\\\n\\critique{first}\nc &= d \\\\n\\critique{second}\n\\end{align}`,
      expected: `\\begin{align}\na &= b \\\\n\\intertext{\\critique{first}}\nc &= d \\\\n\\intertext{\\critique{second}}\n\\end{align}`,
    },
    {
      name: 'handles nested braces in critique content',
      input: `\\begin{align}\n\\critique{This is \\textbf{bold}}\n\\end{align}`,
      expected: `\\begin{align}\n\\intertext{\\critique{This is \\textbf{bold}}}\n\\end{align}`,
    },
    {
      name: 'leaves existing intertext wrapping unchanged',
      input: `\\begin{align}\n\\intertext{\\critique{note}}\n\\end{align}`,
      expected: `\\begin{align}\n\\intertext{\\critique{note}}\n\\end{align}`,
    },
    {
      name: 'does not touch critique outside align',
      input: `Outside \\critique{remark}`,
      expected: `Outside \\critique{remark}`,
    },
  ])('$name', ({ input, expected }) => {
    assert.strictEqual(wrapCritiqueInAlign(input), expected);
  });

  it('is idempotent for comment', () => {
    const input = `\\begin{align}\n\\comment{note}\n\\end{align}`;
    const once = wrapCritiqueInAlign(input);
    assert.strictEqual(wrapCritiqueInAlign(once), once);
  });
});
