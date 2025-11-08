import { strict as assert } from 'assert';

import { applyReplacements } from '@replacement/engine';
import { EQUATION_STYLE_REPLACEMENTS } from '@replacement/rulesRegex';

describe('equation environment linebreak normalization', () => {
  it('collapses multiple blank lines after equation begins', () => {
    const input = ['\\begin{align}', '', '', '  x &= y', '\\end{align}'].join(
      '\n',
    );
    const expected = ['\\begin{align}', '  x &= y', '\\end{align}'].join('\n');
    const result = applyReplacements(input, EQUATION_STYLE_REPLACEMENTS, {
      processMathUnicode: false,
    });

    assert.strictEqual(result, expected);
  });

  it('collapses multiple blank lines before equation ends', () => {
    const input = [
      '\\begin{gather}',
      '  y = z',
      '',
      '',
      '    \\end{gather}',
    ].join('\n');
    const expected = ['\\begin{gather}', '  y = z', '    \\end{gather}'].join(
      '\n',
    );
    const result = applyReplacements(input, EQUATION_STYLE_REPLACEMENTS, {
      processMathUnicode: false,
    });

    assert.strictEqual(result, expected);
  });

  it('handles Windows newlines for starred environments', () => {
    const input = [
      '\\begin{equation*}',
      '',
      '',
      'a = b',
      '',
      '',
      '\\end{equation*}',
    ].join('\r\n');
    const expected = ['\\begin{equation*}', 'a = b', '\\end{equation*}'].join(
      '\r\n',
    );
    const result = applyReplacements(input, EQUATION_STYLE_REPLACEMENTS, {
      processMathUnicode: false,
    });

    assert.strictEqual(result, expected);
  });

  it('fixes duplicated begin/end environment wrappers', () => {
    const input = String.raw`\\begin{begin{eqnarray}}
x = y\\
\\end{end{eqnarray}}`;
    const expected = String.raw`\\begin{eqnarray}
x = y\\
\\end{eqnarray}`;

    const result = applyReplacements(input, EQUATION_STYLE_REPLACEMENTS, {
      processMathUnicode: false,
    });

    assert.strictEqual(result, expected);
  });
});
