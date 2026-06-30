// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Node.js built-in imports

// Internal imports
import { applyReplacements } from '@replacement/engine';
import { LATEX_FORBIDDEN_REPLACEMENTS } from '@replacement/rules';

function convert(input: string): string {
  return applyReplacements(input, LATEX_FORBIDDEN_REPLACEMENTS, {
    processMathUnicode: false,
  });
}

describe('latex forbidden commands replacements', () => {
  it.each([
    {
      name: 'removes invalid section endings',
      input: '\\section{Intro}\n\\end{section}\nBody',
      expected: '\\section{Intro}\n\nBody',
    },
    {
      name: 'removes starred invalid endings',
      input: '\\subsection*{Overview}\n\\end{subsection*}\nMore',
      expected: '\\subsection*{Overview}\n\nMore',
    },
    {
      name: 'removes endings with stray spaces',
      input: '\\paragraph{Detail}\n\\end {paragraph}\nNext',
      expected: '\\paragraph{Detail}\n\nNext',
    },
    {
      name: 'removes endings with space after opening brace',
      input: '\\section{Intro}\n\\end{ section}\nBody',
      expected: '\\section{Intro}\n\nBody',
    },
    {
      name: 'removes endings with space before closing brace',
      input: '\\subsection{Part}\n\\end{subsection }\nMore',
      expected: '\\subsection{Part}\n\nMore',
    },
    {
      name: 'removes starred endings with spaces in multiple positions',
      input: '\\section*{Title}\n\\end { section* }\nText',
      expected: '\\section*{Title}\n\nText',
    },
    {
      name: 'handles multiple invalid endings in one document',
      input: '\\section{A}\n\\end{section}\nText\n\\section{B}\n\\end{section}',
      expected: '\\section{A}\n\nText\n\\section{B}\n',
    },
  ])('$name', ({ input, expected }) => {
    assert.strictEqual(convert(input), expected);
  });

  it('removes invalid endings for all section types', () => {
    const input =
      '\\chapter{Ch}\n\\end{chapter}\n\\section{S}\n\\end{section}\n\\subsubsection{SS}\n\\end{subsubsection}';
    const result = convert(input);
    assert.strictEqual(result.includes('\\end{chapter}'), false);
    assert.strictEqual(result.includes('\\end{section}'), false);
    assert.strictEqual(result.includes('\\end{subsubsection}'), false);
  });
});
