import { strict as assert } from 'assert';

import { escapeTextttUnderscores } from '@replacement/advanced';
import { applyReplacements } from '@replacement/engine';
import { EQUATION_STYLE_REPLACEMENTS } from '@replacement/rulesRegex';

describe('escapeTextttUnderscores', () => {
  it('escapes bare underscores inside texttt blocks', () => {
    const input = '\\texttt{ch:BELIEF_PROP}';
    const expected = '\\texttt{ch:BELIEF\\_PROP}';
    assert.strictEqual(escapeTextttUnderscores(input), expected);
  });

  it('escapes multiple bare underscores', () => {
    const input = '\\texttt{multi_part_identifier}';
    const expected = '\\texttt{multi\\_part\\_identifier}';
    assert.strictEqual(escapeTextttUnderscores(input), expected);
  });

  it('preserves already escaped underscores', () => {
    const input = '\\texttt{already\\_escaped}';
    assert.strictEqual(escapeTextttUnderscores(input), input);
  });

  it('handles nested braces safely', () => {
    const input = '\\texttt{outer_{inner_value}}';
    const expected = '\\texttt{outer\\_{inner\\_value}}';
    assert.strictEqual(escapeTextttUnderscores(input), expected);
  });

  it('leaves content without texttt unchanged', () => {
    const input = 'plain_text_with_underscores';
    assert.strictEqual(escapeTextttUnderscores(input), input);
  });
});

describe('escapeTextttUnderscores integration', () => {
  it('runs as part of applyReplacements', () => {
    const input = 'See \\texttt{file_name} for details';
    const expected = 'See \\texttt{file\\_name} for details';
    const result = applyReplacements(input, EQUATION_STYLE_REPLACEMENTS, {
      processMathUnicode: false,
    });
    assert.strictEqual(result, expected);
  });
});
