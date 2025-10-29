import { strict as assert } from 'assert';

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
});
