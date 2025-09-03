import { strict as assert } from 'assert';

import { applyReplacements } from '@replacement/engine';
import { EQUATION_STYLE_REPLACEMENTS } from '@replacement/rulesRegex';

describe('reference underscore replacements', () => {
  it('removes escapes in \\ref', () => {
    const input = '\\ref{ch:THREE\\_FLUCT\\_THM}';
    const expected = '\\ref{ch:THREE_FLUCT_THM}';
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
});
