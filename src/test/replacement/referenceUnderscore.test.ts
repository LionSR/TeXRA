import { strict as assert } from 'assert';

import { applyReplacements } from '@replacement/engine';
import { EQUATION_STYLE_REPLACEMENTS } from '@replacement/rulesRegex';

describe('reference underscore replacements', () => {
  it('handles multiple underscores in one reference', () => {
    const input = '\\ref{sec\\_one\\_two\\_three}';
    const expected = '\\ref{sec_one_two_three}';
    const result = applyReplacements(input, EQUATION_STYLE_REPLACEMENTS, {
      processMathUnicode: false,
    });
    assert.strictEqual(result, expected);
  });

  it('removes escapes in \\cref and \\eqref', () => {
    const input = '\\cref{sec\\_one} and \\eqref{eq\\_1}';
    const expected = '\\cref{sec_one} and \\eqref{eq_1}';
    const result = applyReplacements(input, EQUATION_STYLE_REPLACEMENTS, {
      processMathUnicode: false,
    });
    assert.strictEqual(result, expected);
  });

  it('leaves unescaped underscores unchanged', () => {
    const input = '\\ref{sec_one\\_two}';
    const expected = '\\ref{sec_one_two}';
    const result = applyReplacements(input, EQUATION_STYLE_REPLACEMENTS, {
      processMathUnicode: false,
    });
    assert.strictEqual(result, expected);
  });

  it('handles multiple references on same line', () => {
    const input = 'See \\ref{fig\\_1} and \\cref{tab\\_2}';
    const expected = 'See \\ref{fig_1} and \\cref{tab_2}';
    const result = applyReplacements(input, EQUATION_STYLE_REPLACEMENTS, {
      processMathUnicode: false,
    });
    assert.strictEqual(result, expected);
  });

  it('does not affect underscores outside reference commands', () => {
    const input = '\\textit{some\\_text} \\ref{valid\\_ref}';
    const expected = '\\textit{some\\_text} \\ref{valid_ref}';
    const result = applyReplacements(input, EQUATION_STYLE_REPLACEMENTS, {
      processMathUnicode: false,
    });
    assert.strictEqual(result, expected);
  });
});
