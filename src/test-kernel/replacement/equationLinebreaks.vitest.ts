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

describe('equation environment linebreak normalization', () => {
  it.each([
    {
      name: 'collapses multiple blank lines after equation begins',
      input: ['\\begin{align}', '', '', '  x &= y', '\\end{align}'].join('\n'),
      expected: ['\\begin{align}', '  x &= y', '\\end{align}'].join('\n'),
    },
    {
      name: 'collapses multiple blank lines before equation ends',
      input: ['\\begin{gather}', '  y = z', '', '', '    \\end{gather}'].join(
        '\n',
      ),
      expected: ['\\begin{gather}', '  y = z', '    \\end{gather}'].join('\n'),
    },
    {
      name: 'handles Windows newlines for starred environments',
      input: [
        '\\begin{equation*}',
        '',
        '',
        'a = b',
        '',
        '',
        '\\end{equation*}',
      ].join('\r\n'),
      expected: ['\\begin{equation*}', 'a = b', '\\end{equation*}'].join(
        '\r\n',
      ),
    },
    {
      name: 'fixes duplicated begin/end environment wrappers',
      input: String.raw`\\begin{begin{eqnarray}}
x = y\\
\\end{end{eqnarray}}`,
      expected: String.raw`\\begin{eqnarray}
x = y\\
\\end{eqnarray}`,
    },
  ])('$name', ({ input, expected }) => {
    assert.strictEqual(convert(input), expected);
  });
});
