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

const multiLineCaption = [
  '\\caption{',
  '  This is a long caption',
  '  that spans multiple lines',
  '}',
].join('\n');

const embeddedNewlineCaption = [
  '\\caption{  ',
  '  First line',
  '  Second line',
  '  }',
].join('\n');

describe('caption spacing normalization', () => {
  it.each([
    {
      name: 'trims tabs in single-line caption',
      input: '\\caption{\tMy caption\t}',
      expected: '\\caption{My caption}',
    },
    {
      name: 'trims spaces in single-line caption',
      input: '\\caption{  My caption  }',
      expected: '\\caption{My caption}',
    },
    {
      name: 'trims mixed spaces and tabs in single-line caption',
      input: '\\caption{ \tMy caption\t }',
      expected: '\\caption{My caption}',
    },
    {
      name: 'preserves multi-line captions',
      input: multiLineCaption,
      expected: multiLineCaption,
    },
    {
      name: 'trims caption* variants',
      input: '\\caption*{\tSpecial caption\t}',
      expected: '\\caption*{Special caption}',
    },
    {
      name: 'preserves nested braces within captions',
      input: '\\caption{  Text with {nested braces}  }',
      expected: '\\caption{Text with {nested braces}}',
    },
    {
      name: 'keeps captions with embedded newlines unchanged even with surrounding spaces',
      input: embeddedNewlineCaption,
      expected: embeddedNewlineCaption,
    },
  ])('$name', ({ input, expected }) => {
    assert.strictEqual(convert(input), expected);
  });
});
