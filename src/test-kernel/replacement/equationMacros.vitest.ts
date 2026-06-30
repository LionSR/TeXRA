// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Node.js built-in imports

// Internal imports
import { applyReplacements } from '@replacement/engine';
import { EQUATION_MACRO_REPLACEMENTS } from '@replacement/rules';

function applyMacros(input: string): string {
  return applyReplacements(input, EQUATION_MACRO_REPLACEMENTS, {
    processMathUnicode: false,
  });
}

describe('equation macro replacements', () => {
  it.each([
    {
      name: 'expands be/ee pairs into equation environments',
      input: String.raw`\be
W = a
\ee`,
      expected: String.raw`\begin{equation}
W = a
\end{equation}`,
    },
    {
      name: 'preserves indentation when expanding macros',
      input: String.raw`  \bse
    f(x)
  \ese`,
      expected: String.raw`  \begin{subequations}
    f(x)
  \end{subequations}`,
    },
    {
      // Real trailing spaces after \be and a real tab after \ee. The previous
      // String.raw fixture kept the space and tab escapes as literal text, which
      // the own-line macro pattern (correctly) refuses to match.
      name: 'handles trailing whitespace on macro lines',
      input: '\\be   \nE = mc^2\n\\ee\t',
      expected: '\\begin{equation}   \nE = mc^2\n\\end{equation}\t',
    },
    {
      name: 'converts extended macros without triggering partial matches',
      input: String.raw`\bea
x = y
\eea`,
      expected: String.raw`\begin{eqnarray}
x = y
\end{eqnarray}`,
    },
    {
      name: 'leaves unrelated commands untouched',
      input: String.raw`\beta = 0`,
      expected: String.raw`\beta = 0`,
    },
    {
      name: 'ignores inline macro mentions',
      input: String.raw`Text before \be text after`,
      expected: String.raw`Text before \be text after`,
    },
    {
      name: 'is case sensitive to match legacy lowercase helpers only',
      input: String.raw`\BE`,
      expected: String.raw`\BE`,
    },
  ])('$name', ({ input, expected }) => {
    assert.strictEqual(applyMacros(input), expected);
  });
});
