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

  it('removes endings with space after opening brace', () => {
    const input = '\\section{Intro}\n\\end{ section}\nBody';
    const expected = '\\section{Intro}\n\nBody';
    const result = applyReplacements(input, LATEX_FORBIDDEN_REPLACEMENTS, {
      processMathUnicode: false,
    });
    assert.strictEqual(result, expected);
  });

  it('removes endings with space before closing brace', () => {
    const input = '\\subsection{Part}\n\\end{subsection }\nMore';
    const expected = '\\subsection{Part}\n\nMore';
    const result = applyReplacements(input, LATEX_FORBIDDEN_REPLACEMENTS, {
      processMathUnicode: false,
    });
    assert.strictEqual(result, expected);
  });

  it('removes starred endings with spaces in multiple positions', () => {
    const input = '\\section*{Title}\n\\end { section* }\nText';
    const expected = '\\section*{Title}\n\nText';
    const result = applyReplacements(input, LATEX_FORBIDDEN_REPLACEMENTS, {
      processMathUnicode: false,
    });
    assert.strictEqual(result, expected);
  });

  it('removes invalid endings for all section types', () => {
    const input =
      '\\chapter{Ch}\n\\end{chapter}\n\\section{S}\n\\end{section}\n\\subsubsection{SS}\n\\end{subsubsection}';
    const result = applyReplacements(input, LATEX_FORBIDDEN_REPLACEMENTS, {
      processMathUnicode: false,
    });
    assert.strictEqual(result.includes('\\end{chapter}'), false);
    assert.strictEqual(result.includes('\\end{section}'), false);
    assert.strictEqual(result.includes('\\end{subsubsection}'), false);
  });

  it('handles multiple invalid endings in one document', () => {
    const input = '\\section{A}\n\\end{section}\nText\n\\section{B}\n\\end{section}';
    const expected = '\\section{A}\n\nText\n\\section{B}\n';
    const result = applyReplacements(input, LATEX_FORBIDDEN_REPLACEMENTS, {
      processMathUnicode: false,
    });
    assert.strictEqual(result, expected);
  });
});
