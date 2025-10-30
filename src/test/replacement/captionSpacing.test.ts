import { strict as assert } from 'assert';

import { applyReplacements } from '@replacement/engine';
import { EQUATION_STYLE_REPLACEMENTS } from '@replacement/rulesRegex';

describe('caption spacing normalization', () => {
  it('trims tabs in single-line caption', () => {
    const input = '\\caption{\tMy caption\t}';
    const expected = '\\caption{My caption}';
    const result = applyReplacements(input, EQUATION_STYLE_REPLACEMENTS, {
      processMathUnicode: false,
    });
    assert.strictEqual(result, expected);
  });

  it('trims spaces in single-line caption', () => {
    const input = '\\caption{  My caption  }';
    const expected = '\\caption{My caption}';
    const result = applyReplacements(input, EQUATION_STYLE_REPLACEMENTS, {
      processMathUnicode: false,
    });
    assert.strictEqual(result, expected);
  });

  it('trims mixed spaces and tabs in single-line caption', () => {
    const input = '\\caption{ \tMy caption\t }';
    const expected = '\\caption{My caption}';
    const result = applyReplacements(input, EQUATION_STYLE_REPLACEMENTS, {
      processMathUnicode: false,
    });
    assert.strictEqual(result, expected);
  });

  it('preserves multi-line captions', () => {
    const input = ['\\caption{', '  This is a long caption', '  that spans multiple lines', '}'].join('\n');
    const expected = input;
    const result = applyReplacements(input, EQUATION_STYLE_REPLACEMENTS, {
      processMathUnicode: false,
    });
    assert.strictEqual(result, expected);
  });

  it('trims caption* variants', () => {
    const input = '\\caption*{\tSpecial caption\t}';
    const expected = '\\caption*{Special caption}';
    const result = applyReplacements(input, EQUATION_STYLE_REPLACEMENTS, {
      processMathUnicode: false,
    });
    assert.strictEqual(result, expected);
  });

  it('preserves nested braces within captions', () => {
    const input = '\\caption{  Text with {nested braces}  }';
    const expected = '\\caption{Text with {nested braces}}';
    const result = applyReplacements(input, EQUATION_STYLE_REPLACEMENTS, {
      processMathUnicode: false,
    });
    assert.strictEqual(result, expected);
  });

  it('keeps captions with embedded newlines unchanged even with surrounding spaces', () => {
    const input = ['\\caption{  ', '  First line', '  Second line', '  }'].join('\n');
    const expected = input;
    const result = applyReplacements(input, EQUATION_STYLE_REPLACEMENTS, {
      processMathUnicode: false,
    });
    assert.strictEqual(result, expected);
  });
});
