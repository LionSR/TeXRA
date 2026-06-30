// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Node.js built-in imports

// Internal imports
import { applyReplacements } from '@replacement/engine';
import { EQUATION_STYLE_REPLACEMENTS } from '@replacement/rulesRegex';

function convert(input: string): string {
  return applyReplacements(input, EQUATION_STYLE_REPLACEMENTS, {
    processMathUnicode: false,
  });
}

describe('reference underscore replacements', () => {
  it.each([
    {
      name: 'handles multiple underscores in one reference',
      input: '\\ref{sec\\_one\\_two\\_three}',
      expected: '\\ref{sec_one_two_three}',
    },
    {
      name: 'removes escapes in \\cref and \\eqref',
      input: '\\cref{sec\\_one} and \\eqref{eq\\_1}',
      expected: '\\cref{sec_one} and \\eqref{eq_1}',
    },
    {
      name: 'leaves unescaped underscores unchanged',
      input: '\\ref{sec_one\\_two}',
      expected: '\\ref{sec_one_two}',
    },
    {
      name: 'handles multiple references on same line',
      input: 'See \\ref{fig\\_1} and \\cref{tab\\_2}',
      expected: 'See \\ref{fig_1} and \\cref{tab_2}',
    },
    {
      name: 'does not affect underscores outside reference commands',
      input: '\\textit{some\\_text} \\ref{valid\\_ref}',
      expected: '\\textit{some\\_text} \\ref{valid_ref}',
    },
  ])('$name', ({ input, expected }) => {
    assert.strictEqual(convert(input), expected);
  });
});
