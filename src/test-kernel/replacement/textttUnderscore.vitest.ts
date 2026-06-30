// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Node.js built-in imports

// Internal imports
import { escapeTextttUnderscores } from '@replacement/advanced';
import { applyReplacements } from '@replacement/engine';
import { EQUATION_STYLE_REPLACEMENTS } from '@replacement/rulesRegex';

describe('escapeTextttUnderscores', () => {
  it.each([
    {
      name: 'escapes bare underscores inside texttt blocks',
      input: '\\texttt{ch:BELIEF_PROP}',
      expected: '\\texttt{ch:BELIEF\\_PROP}',
    },
    {
      name: 'escapes multiple bare underscores',
      input: '\\texttt{multi_part_identifier}',
      expected: '\\texttt{multi\\_part\\_identifier}',
    },
    {
      name: 'preserves already escaped underscores',
      input: '\\texttt{already\\_escaped}',
      expected: '\\texttt{already\\_escaped}',
    },
    {
      name: 'handles underscores adjacent to braces',
      input: '\\texttt{outer_{inner_value}}',
      expected: '\\texttt{outer\\_{inner\\_value}}',
    },
    {
      name: 'leaves content without texttt unchanged',
      input: 'plain_text_with_underscores',
      expected: 'plain_text_with_underscores',
    },
  ])('$name', ({ input, expected }) => {
    assert.strictEqual(escapeTextttUnderscores(input), expected);
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
