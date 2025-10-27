import { strict as assert } from 'assert';

import { applyReplacements } from '@replacement/engine';
import { LATEX_FORBIDDEN_REPLACEMENTS } from '@replacement/rules';

describe('latex forbidden commands replacements', () => {
  it('removes invalid section endings', () => {
    const input = '\\section{Intro}\n\\end{section}\nBody';
    const expected = '\\section{Intro}\n\nBody';
    const result = applyReplacements(input, LATEX_FORBIDDEN_REPLACEMENTS, {
      processMathUnicode: false,
    });
    assert.strictEqual(result, expected);
  });

  it('removes starred invalid endings', () => {
    const input = '\\subsection*{Overview}\n\\end{subsection*}\nMore';
    const expected = '\\subsection*{Overview}\n\nMore';
    const result = applyReplacements(input, LATEX_FORBIDDEN_REPLACEMENTS, {
      processMathUnicode: false,
    });
    assert.strictEqual(result, expected);
  });

  it('removes endings with stray spaces', () => {
    const input = '\\paragraph{Detail}\n\\end {paragraph}\nNext';
    const expected = '\\paragraph{Detail}\n\nNext';
    const result = applyReplacements(input, LATEX_FORBIDDEN_REPLACEMENTS, {
      processMathUnicode: false,
    });
    assert.strictEqual(result, expected);
  });
});
