// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Node.js built-in imports

// Internal imports
import { applyReplacements } from '@replacement/engine';
import { EQUATION_MACRO_REPLACEMENTS } from '@replacement/rules';

const applyMacros = (input: string): string =>
  applyReplacements(input, EQUATION_MACRO_REPLACEMENTS, {
    processMathUnicode: false,
  });

describe('equation macro replacements', () => {
  it('expands be/ee pairs into equation environments', () => {
    const input = String.raw`\be
W = a
\ee`;
    const expected = String.raw`\begin{equation}
W = a
\end{equation}`;

    const result = applyMacros(input);
    assert.strictEqual(result, expected);
  });

  it('preserves indentation when expanding macros', () => {
    const input = String.raw`  \bse
    f(x)
  \ese`;
    const expected = String.raw`  \begin{subequations}
    f(x)
  \end{subequations}`;

    const result = applyMacros(input);
    assert.strictEqual(result, expected);
  });

  it('handles trailing whitespace on macro lines', () => {
    // Real trailing spaces after \be and a real tab after \ee. The previous
    // String.raw fixture kept the \u0020 / \t escapes as literal text, which
    // the own-line macro pattern (correctly) refuses to match.
    const input = '\\be   \nE = mc^2\n\\ee\t';
    const expected = '\\begin{equation}   \nE = mc^2\n\\end{equation}\t';

    const result = applyMacros(input);
    assert.strictEqual(result, expected);
  });

  it('converts extended macros without triggering partial matches', () => {
    const input = String.raw`\bea
x = y
\eea`;
    const expected = String.raw`\begin{eqnarray}
x = y
\end{eqnarray}`;

    const result = applyMacros(input);
    assert.strictEqual(result, expected);
  });

  it('leaves unrelated commands untouched', () => {
    const input = String.raw`\beta = 0`;
    const result = applyMacros(input);
    assert.strictEqual(result, input);
  });

  it('ignores inline macro mentions', () => {
    const input = String.raw`Text before \be text after`;
    const result = applyMacros(input);
    assert.strictEqual(result, input);
  });

  it('is case sensitive to match legacy lowercase helpers only', () => {
    const input = String.raw`\BE`;
    const result = applyMacros(input);
    assert.strictEqual(result, input);
  });
});
