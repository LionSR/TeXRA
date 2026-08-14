// Replacement-rule suites folded into one domain suite for src/replacement
// (engine + rules + rulesRegex + advanced).

import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import replacementEngine, {
  applyReplacements,
  NON_REGEX_CATEGORIES,
  REGEX_CATEGORIES,
} from '@replacement/engine';
import {
  EQUATION_MACRO_REPLACEMENTS,
  EQUATION_STYLE_REPLACEMENTS,
  FENCED_LATEX_BLOCK_REPLACEMENTS,
} from '@replacement/rulesRegex';
import {
  HTML_ENTITY_REPLACEMENTS,
  LATEX_FORBIDDEN_REPLACEMENTS,
  LATEX_XML_REPLACEMENTS,
} from '@replacement/rules';
import {
  escapeTextttUnderscores,
  stripCriticizeAnnotations,
  wrapCritiqueInAlign,
} from '@replacement/advanced';
import type { ReplacementCategory } from '@replacement/types';
import {
  NON_REGEX_REPLACEMENT_CATEGORIES,
  REGEX_REPLACEMENT_CATEGORIES,
} from '@shared/constants/replacementCategories';

// ---------------------------------------------------------------------------
// captionSpacing
// ---------------------------------------------------------------------------

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

describe('replacement category registry completeness', () => {
  it('keeps the non-regex application registry in sync with the config universe', () => {
    const registryNames = NON_REGEX_CATEGORIES.map((c) => c.name);
    // Every category the engine can run is a config-accepted name…
    assert.deepEqual(
      [...new Set(registryNames)].sort(),
      [...NON_REGEX_REPLACEMENT_CATEGORIES].sort(),
    );
    // …and every config-accepted name has an implementation that actually runs.
    for (const name of NON_REGEX_REPLACEMENT_CATEGORIES) {
      assert.ok(
        registryNames.includes(name),
        `non-regex category "${name}" is accepted by config but never runs`,
      );
    }
  });

  it('keeps the regex application registry in sync with the config universe', () => {
    const registryNames = REGEX_CATEGORIES.map((c) => c.name);
    assert.deepEqual(
      [...new Set(registryNames)].sort(),
      [...REGEX_REPLACEMENT_CATEGORIES].sort(),
    );
    for (const name of REGEX_REPLACEMENT_CATEGORIES) {
      assert.ok(
        registryNames.includes(name),
        `regex category "${name}" is accepted by config but never runs`,
      );
    }
  });
});

describe('caption spacing normalization', () => {
  it.each([
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
    assert.strictEqual(
      applyReplacements(input, EQUATION_STYLE_REPLACEMENTS),
      expected,
    );
  });
});

// ---------------------------------------------------------------------------
// equationLinebreaks
// ---------------------------------------------------------------------------

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
    assert.strictEqual(
      applyReplacements(input, EQUATION_STYLE_REPLACEMENTS),
      expected,
    );
  });
});

// ---------------------------------------------------------------------------
// equationMacros
// ---------------------------------------------------------------------------

describe('equation macro replacements', () => {
  it.each([
    {
      name: 'expands be/ee pairs into equation environments',
      input: String.raw`\be
W = a
\ee`,
      expected: String.raw`\begin{equation}
W = a
\end{equation}`,
    },
    {
      name: 'preserves indentation when expanding macros',
      input: String.raw`  \bse
    f(x)
  \ese`,
      expected: String.raw`  \begin{subequations}
    f(x)
  \end{subequations}`,
    },
    {
      // Real trailing spaces after \be and a real tab after \ee. The previous
      // String.raw fixture kept the space and tab escapes as literal text, which
      // the own-line macro pattern (correctly) refuses to match.
      name: 'handles trailing whitespace on macro lines',
      input: '\\be   \nE = mc^2\n\\ee\t',
      expected: '\\begin{equation}   \nE = mc^2\n\\end{equation}\t',
    },
    {
      name: 'converts extended macros without triggering partial matches',
      input: String.raw`\bea
x = y
\eea`,
      expected: String.raw`\begin{eqnarray}
x = y
\end{eqnarray}`,
    },
    {
      name: 'leaves unrelated commands untouched',
      input: String.raw`\beta = 0`,
      expected: String.raw`\beta = 0`,
    },
    {
      name: 'ignores inline macro mentions',
      input: String.raw`Text before \be text after`,
      expected: String.raw`Text before \be text after`,
    },
    {
      name: 'is case sensitive to match legacy lowercase helpers only',
      input: String.raw`\BE`,
      expected: String.raw`\BE`,
    },
  ])('$name', ({ input, expected }) => {
    assert.strictEqual(
      applyReplacements(input, EQUATION_MACRO_REPLACEMENTS),
      expected,
    );
  });
});

// ---------------------------------------------------------------------------
// fencedLatexBlocksRegex
// ---------------------------------------------------------------------------

describe('FENCED_LATEX_BLOCK_REPLACEMENTS', () => {
  it.each([
    {
      name: 'converts a basic aligned fence',
      input: String.raw`::: aligned
&= a + b\\
:::
`,
      expected: String.raw`\begin{aligned}
&= a + b\\
\end{aligned}
`,
    },
    {
      name: 'preserves indentation for align* blocks',
      input: String.raw`
  ::: align*
  x &= y\\
  :::
`,
      expected: String.raw`
  \begin{align*}
  x &= y\\
  \end{align*}
`,
    },
    {
      name: 'produces empty environments for blank bodies',
      input: String.raw`::: aligned
:::
`,
      expected: String.raw`\begin{aligned}

\end{aligned}
`,
    },
    {
      // Whitespace between the body and the closing fence stays part of the
      // body (see the trailing-spaces case below).
      name: 'converts inline fenced aligned blocks',
      input: '::: aligned {_i=1^n X_i t} &(-) :::',
      expected: '\\begin{aligned}\n{_i=1^n X_i t} &(-) \n\\end{aligned}',
    },
    {
      name: 'captures inline bodies with trailing spaces before the fence',
      input: '::: aligned a + b    :::',
      expected: '\\begin{aligned}\na + b    \n\\end{aligned}',
    },
    {
      name: 'preserves CRLF line endings',
      input: '::: align*\r\n&= a + b\\\\\r\n:::\r\n',
      expected: '\\begin{align*}\r\n&= a + b\\\\\r\n\\end{align*}\r\n',
    },
    {
      name: 'appends a trailing newline when the body lacks one',
      input: String.raw`::: gather
1\\
2
:::
`,
      expected: String.raw`\begin{gather}
1\\
2
\end{gather}
`,
    },
    {
      name: 'handles multiple fenced blocks in the same string',
      input: String.raw`::: aligned
0\\
:::
Text
::: gather
1\\\\
2
:::
`,
      expected: String.raw`\begin{aligned}
0\\
\end{aligned}
Text
\begin{gather}
1\\\\
2
\end{gather}
`,
    },
    {
      name: 'ignores unsupported fence names',
      input: String.raw`::: tip
content
:::
`,
      expected: String.raw`::: tip
content
:::
`,
    },
  ])('$name', ({ input, expected }) => {
    assert.strictEqual(
      applyReplacements(input, FENCED_LATEX_BLOCK_REPLACEMENTS),
      expected,
    );
  });

  it('is idempotent when applied repeatedly', () => {
    const input = String.raw`::: aligned
&= 0
:::
`;
    const once = applyReplacements(input, FENCED_LATEX_BLOCK_REPLACEMENTS);
    assert.strictEqual(
      applyReplacements(once, FENCED_LATEX_BLOCK_REPLACEMENTS),
      once,
    );
  });
});

// ---------------------------------------------------------------------------
// htmlEntities
// ---------------------------------------------------------------------------

describe('html entity replacements', () => {
  it('converts escaped xml tags into LaTeX environments', () => {
    // 'response' is one of the LATEX_ENVIRONMENTS covered by the XML-to-LaTeX
    // conversions; arbitrary tag names are intentionally left untouched.
    const input = '&lt;response&gt;Great job&lt;/response&gt;';
    const expected = '\\begin{response}Great job\\end{response}';

    const result = applyReplacements(input, [
      HTML_ENTITY_REPLACEMENTS,
      LATEX_XML_REPLACEMENTS,
    ]);

    assert.strictEqual(result, expected);
  });

  it('decodes common entities to LaTeX-safe output', () => {
    const input = 'Usage&nbsp;&amp;&nbsp;limits remain &le; 10';
    const expected = 'Usage~\\&~limits remain \\leq 10';

    const result = applyReplacements(input, HTML_ENTITY_REPLACEMENTS);

    assert.strictEqual(result, expected);
  });

  it('covers extended math and greek entities safely', () => {
    const input =
      'Angles &ne; 0 &alpha;&rArr;&infin; &sum;=1 45&deg; &quot;quoted&quot; &frac12;&nbsp;items &Delta;&theta;';
    const expected =
      'Angles \\neq 0 \\alpha\\Rightarrow\\infty \\sum=1 45^{\\circ} "quoted" \\frac{1}{2}~items \\Delta\\theta';

    const result = applyReplacements(input, HTML_ENTITY_REPLACEMENTS);

    assert.strictEqual(result, expected);
  });
});

// ---------------------------------------------------------------------------
// latexForbiddenCommands
// ---------------------------------------------------------------------------

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
    assert.strictEqual(
      applyReplacements(input, LATEX_FORBIDDEN_REPLACEMENTS),
      expected,
    );
  });

  it('removes invalid endings for all section types', () => {
    const input =
      '\\chapter{Ch}\n\\end{chapter}\n\\section{S}\n\\end{section}\n\\subsubsection{SS}\n\\end{subsubsection}';
    const result = applyReplacements(input, LATEX_FORBIDDEN_REPLACEMENTS);
    assert.strictEqual(result.includes('\\end{chapter}'), false);
    assert.strictEqual(result.includes('\\end{section}'), false);
    assert.strictEqual(result.includes('\\end{subsubsection}'), false);
  });
});

// ---------------------------------------------------------------------------
// personalStyleContextual
// ---------------------------------------------------------------------------

describe('personal style contextual replacements', () => {
  it('keeps macro definitions intact while rewriting usages', () => {
    const input = [
      '\\newcommand{\\tr}{\\mathrm{Tr}}',
      '\\newcommand{\\trace}[1]{\\mathrm{Tr}(#1)}',
      '\\renewcommand{\\Tr}{\\mathrm{tr}}',
      '\\providecommand{\\smalltr}{\\mathrm{tr}}',
      '$\\mathrm{Tr}$ and $\\mathrm{tr}$',
    ].join('\n');

    const result = replacementEngine.applyAll(input);

    const expected = [
      '\\newcommand{\\tr}{\\mathrm{Tr}}',
      '\\newcommand{\\trace}[1]{\\mathrm{Tr}(#1)}',
      '\\renewcommand{\\Tr}{\\mathrm{tr}}',
      '\\providecommand{\\smalltr}{\\mathrm{tr}}',
      '$\\Tr$ and $\\tr$',
    ].join('\n');

    assert.strictEqual(result, expected);
  });
});

// ---------------------------------------------------------------------------
// referenceUnderscore
// ---------------------------------------------------------------------------

describe('reference underscore replacements', () => {
  it.each([
    {
      name: 'handles multiple underscores in one reference',
      input: '\\ref{sec\\_one\\_two\\_three}',
      expected: '\\ref{sec_one_two_three}',
    },
    {
      name: 'removes escapes in \\cref and \\eqref',
      input: '\\cref{sec\\_one} and \\eqref{eq\\_1}',
      expected: '\\cref{sec_one} and \\eqref{eq_1}',
    },
    {
      name: 'leaves unescaped underscores unchanged',
      input: '\\ref{sec_one\\_two}',
      expected: '\\ref{sec_one_two}',
    },
    {
      name: 'handles multiple references on same line',
      input: 'See \\ref{fig\\_1} and \\cref{tab\\_2}',
      expected: 'See \\ref{fig_1} and \\cref{tab_2}',
    },
    {
      name: 'does not affect underscores outside reference commands',
      input: '\\textit{some\\_text} \\ref{valid\\_ref}',
      expected: '\\textit{some\\_text} \\ref{valid_ref}',
    },
  ])('$name', ({ input, expected }) => {
    assert.strictEqual(
      applyReplacements(input, EQUATION_STYLE_REPLACEMENTS),
      expected,
    );
  });
});

// ---------------------------------------------------------------------------
// stripCriticizeAnnotations
// ---------------------------------------------------------------------------

describe('stripCriticizeAnnotations', () => {
  it.each([
    {
      name: 'removes a whole-line \\criticize and its trailing newline',
      input: `before\n\\criticize{a}{b}{c}\nafter`,
      content: `before\nafter`,
      count: 1,
    },
    {
      name: 'removes a whole-line \\criticize with leading indentation',
      input: `before\n  \\criticize{a}{b}{c}\nafter`,
      content: `before\nafter`,
      count: 1,
    },
    {
      name: 'preserves trailing text when \\criticize is followed by other content on the same line',
      input: `\\criticize{a}{b}{c} trailing text`,
      content: ` trailing text`,
      count: 1,
    },
    {
      name: 'preserves surrounding prose when \\criticize appears inline',
      input: `This sentence \\criticize{a}{b}{c} continues on.`,
      content: `This sentence  continues on.`,
      count: 1,
    },
    {
      name: 'handles nested braces inside \\criticize arguments',
      input: `\\criticize{note with \\textbf{bold}}{high}{0.9}\n`,
      content: ``,
      count: 1,
    },
    {
      name: 'is a no-op when content has no \\criticize',
      input: `no annotations here`,
      content: `no annotations here`,
      count: 0,
    },
  ])('$name', ({ input, content, count }) => {
    const result = stripCriticizeAnnotations(input);
    assert.strictEqual(result.content, content);
    assert.strictEqual(result.count, count);
  });
});

// ---------------------------------------------------------------------------
// textttUnderscore
// ---------------------------------------------------------------------------

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

  it('runs as part of applyReplacements', () => {
    const input = 'See \\texttt{file_name} for details';
    const expected = 'See \\texttt{file\\_name} for details';
    assert.strictEqual(
      applyReplacements(input, EQUATION_STYLE_REPLACEMENTS),
      expected,
    );
  });
});

// ---------------------------------------------------------------------------
// wrapCritiqueInAlign
// ---------------------------------------------------------------------------

describe('wrapCritiqueInAlign', () => {
  it.each([
    {
      name: 'wraps bare critique inside align',
      input: `\\begin{align}\n\\critique{issue}\n\\end{align}`,
      expected: `\\begin{align}\n\\intertext{\\critique{issue}}\n\\end{align}`,
    },
    {
      name: 'wraps bare critique inside align*',
      input: `\\begin{align*}\n\\critique{issue}\n\\end{align*}`,
      expected: `\\begin{align*}\n\\intertext{\\critique{issue}}\n\\end{align*}`,
    },
    {
      name: 'wraps bare comment inside align',
      input: `\\begin{align}\n\\comment{note}\n\\end{align}`,
      expected: `\\begin{align}\n\\intertext{\\comment{note}}\n\\end{align}`,
    },
    {
      name: 'wraps multiple critiques in same align block',
      input: `\\begin{align}\na &= b \\\\n\\critique{first}\nc &= d \\\\n\\critique{second}\n\\end{align}`,
      expected: `\\begin{align}\na &= b \\\\n\\intertext{\\critique{first}}\nc &= d \\\\n\\intertext{\\critique{second}}\n\\end{align}`,
    },
    {
      name: 'handles nested braces in critique content',
      input: `\\begin{align}\n\\critique{This is \\textbf{bold}}\n\\end{align}`,
      expected: `\\begin{align}\n\\intertext{\\critique{This is \\textbf{bold}}}\n\\end{align}`,
    },
    {
      name: 'leaves existing intertext wrapping unchanged',
      input: `\\begin{align}\n\\intertext{\\critique{note}}\n\\end{align}`,
      expected: `\\begin{align}\n\\intertext{\\critique{note}}\n\\end{align}`,
    },
    {
      name: 'does not touch critique outside align',
      input: `Outside \\critique{remark}`,
      expected: `Outside \\critique{remark}`,
    },
  ])('$name', ({ input, expected }) => {
    assert.strictEqual(wrapCritiqueInAlign(input), expected);
  });

  it('is idempotent for comment', () => {
    const input = `\\begin{align}\n\\comment{note}\n\\end{align}`;
    const once = wrapCritiqueInAlign(input);
    assert.strictEqual(wrapCritiqueInAlign(once), once);
  });
});
