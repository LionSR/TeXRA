// Smoke test for the CLI TUI's ANSI markdown renderer (Phase 3).
//
// We don't snapshot the exact ANSI bytes — that locks the layout in too hard.
// Instead, verify the renderer (a) preserves raw text, (b) doesn't HTML-escape
// inside fenced code, (c) routes through the shared factory + cache without
// crashing, and (d) keeps implementation markers out of the final output.

import { beforeEach, describe, expect, it } from 'vitest';
import stripAnsi from 'strip-ansi';

import {
  _ansiMarkdownStatsForTests,
  _resetAnsiMarkdownForTests,
  renderAnsiMarkdown,
} from '@cli/chat/tui/render/ansiMarkdown';
import { normalizeKnownHtmlForCliMarkdown } from '@cli/chat/tui/render/htmlMarkdownNormalize';

const ESC = String.fromCharCode(27);
const ANSI_SGR_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'u');

const WIDE_CODE_POINT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x11ff],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0x1f300, 0x1faff],
];

function displayWidthForTest(line: string): number {
  let width = 0;
  for (const char of line) {
    const codePoint = char.codePointAt(0) ?? 0;
    width += WIDE_CODE_POINT_RANGES.some(
      ([low, high]) => codePoint >= low && codePoint <= high,
    )
      ? 2
      : 1;
  }
  return width;
}

type RenderOptions = Parameters<typeof renderAnsiMarkdown>[1];

/** Renders markdown and strips ANSI, for assertions on the visible text. */
function renderPlain(markdown: string, options?: RenderOptions): string {
  return stripAnsi(renderAnsiMarkdown(markdown, options));
}

/** Strips ANSI, asserts every line fits `width`, and returns the plain lines. */
function plainLinesWithinWidth(rendered: string, width: number): string[] {
  const lines = stripAnsi(rendered).split('\n');
  for (const line of lines) {
    expect(displayWidthForTest(line)).toBeLessThanOrEqual(width);
  }
  return lines;
}

describe('renderAnsiMarkdown', () => {
  beforeEach(() => {
    _resetAnsiMarkdownForTests();
  });

  it('renders plain prose with no HTML escapes', () => {
    const out = renderAnsiMarkdown('Hello <world>');
    expect(out).toContain('Hello <world>');
    expect(out).not.toContain('&lt;');
    expect(out).not.toContain('&gt;');
  });

  it('keeps bare domains linkified', () => {
    expect(
      renderAnsiMarkdown('Visit example.com', { colorEnabled: false }),
    ).toContain('Visit [example.com]');
  });

  it('renders common HTML formatting without leaking tags', () => {
    const plain = renderPlain(
      [
        '<blockquote class="result"><strong data-kind="agent">Subagent <code title=tool>prover</code> finished execution abc:</strong>',
        '',
        'Done.</blockquote>',
      ].join('\n'),
      { colorEnabled: false, width: 80 },
    );

    expect(plain).toContain('│ Subagent `prover` finished execution abc:');
    expect(plain).toContain('│ Done.');
    expect(plain).not.toContain('<blockquote');
    expect(plain).not.toContain('<strong');
    expect(plain).not.toContain('<code');
  });

  it.each([
    '\\[0<p<1\\]',
    '\\[0<p>1\\]',
    '\\[a<b>c\\]',
    '\\[a<i>c\\]',
    '\\[a<br>c\\]',
    '\\[0<p<1, 1-\\frac{2p}{3}>0, \\frac p3>0\\]',
    '$0<p>1$',
    '$$0<p>1$$',
    '\\(0 < p < 1\\)',
    '\\(0 <p <1\\)',
    '\\(0 <p < 1\\)',
    '\\(0 <p > 1\\)',
    '\\(0 <p> 1\\)',
    '\\(if x <p and y>1 then z\\)',
  ])('preserves a TeX inequality that resembles HTML: %s', (example) => {
    expect(renderPlain(example)).toContain(example);
  });

  it('continues normalizing unpaired and nested HTML formatting', () => {
    const plain = renderPlain(
      '<p class="intro">Unpaired paragraph\n<b data-level=outer>outer <b>inner</b></b>',
    );

    expect(plain).toContain('Unpaired paragraph');
    expect(plain).toContain('outer');
    expect(plain).toContain('inner');
    expect(plain).not.toContain('<p');
    expect(plain).not.toContain('<b');
    expect(plain).not.toContain('</b>');
  });

  it.each([
    ['0<p>1', '01'],
    ['a<b>c', 'a**c'],
    ['a<i>c', 'a_c'],
    ['a<br>c', 'a\nc'],
  ] as const)(
    'retains established bare tag-shaped normalization: %s',
    (source, expected) => {
      expect(normalizeKnownHtmlForCliMarkdown(source)).toBe(expected);
    },
  );

  it('continues normalizing standard boolean HTML attributes', () => {
    const plain = renderPlain(
      [
        '<p hidden>Paragraph <b hidden>bold</b> <code hidden>code</code></p>',
        '<div popover>Popover</div>',
        '<div contenteditable>Editable</div>',
      ].join('\n'),
    );

    expect(plain).toContain('Paragraph');
    expect(plain).toContain('bold');
    expect(plain).toContain('code');
    expect(plain).toContain('Popover');
    expect(plain).toContain('Editable');
    expect(plain).not.toContain('<p hidden>');
    expect(plain).not.toContain('<b hidden>');
    expect(plain).not.toContain('<code hidden>');
    expect(plain).not.toContain('<div popover>');
    expect(plain).not.toContain('<div contenteditable>');
  });

  it('normalizes an opening tag whose discarded attribute contains a dollar', () => {
    expect(
      normalizeKnownHtmlForCliMarkdown(
        '<strong title="$foo">x</strong> then $a<b>c$',
      ),
    ).toBe('**x** then $a<b>c$');
  });

  it('rejects a long invalid valueless attribute without changing the text', () => {
    const source = `<p${' '.repeat(20_000)}x>`;
    expect(normalizeKnownHtmlForCliMarkdown(source)).toBe(source);
  });

  it.each([
    'Cost $5 <strong>today</strong>, then $10',
    'Cost $5 <strong>today</strong>, then ($10)',
    'Cost $5 <strong>today</strong>, then -$10',
    'Cost US$5 <strong>today</strong>, then US$10',
    'Cost $.99 <strong>today</strong>, then $.50',
    'Cost $-5 <strong>today</strong>, then $-10',
    'Cost A$5 <strong>today</strong>, then A$10',
  ])('normalizes HTML between same-line currency amounts: %s', (example) => {
    const normalized = normalizeKnownHtmlForCliMarkdown(example);
    expect(normalized).toBe(
      example.replace('<strong>', '**').replace('</strong>', '**'),
    );
    expect(normalized).not.toContain('<strong>');
    expect(normalized).not.toContain('</strong>');
  });

  it.each([
    ['<strong>$5</strong> and <em>$10</em>', '**$5** and _$10_'],
    ['<strong>US$5</strong> and <em>A$10</em>', '**US$5** and _A$10_'],
  ] as const)(
    'normalizes independently wrapped currency amounts: %s',
    (source, expected) => {
      expect(normalizeKnownHtmlForCliMarkdown(source)).toBe(expected);
    },
  );

  it('normalizes unpaired HTML between same-line currency amounts', () => {
    expect(
      normalizeKnownHtmlForCliMarkdown('Cost $5 <strong>today, then $10'),
    ).toBe('Cost $5 **today, then $10');
  });

  it.each([
    ['Cost $5, then', 'Cost $5, then'],
    ['Cost $50, then', 'Cost $50, then'],
    ['Cost $5.99, then', 'Cost $5.99, then'],
    ['Cost $.99, then', 'Cost $.99, then'],
    ['Cost <b>$5</b>, then', 'Cost **$5**, then'],
  ] as const)(
    'preserves inline math after a standalone currency amount: %s',
    (prefix, expectedPrefix) => {
      expect(
        normalizeKnownHtmlForCliMarkdown(`${prefix} <strong>$a<b>c$</strong>`),
      ).toBe(`${expectedPrefix} **$a<b>c$**`);
    },
  );

  it.each([
    ['$5 x$ <strong>and</strong> $y = 2$', '$5 x$ **and** $y = 2$'],
    ['$10 a$ <b>then</b> $20 b$', '$10 a$ **then** $20 b$'],
    ['$5, x<b>y$', '$5, x<b>y$'],
    ['$5, x$ <strong>and</strong> $z$', '$5, x$ **and** $z$'],
    ['$5, x<b>y$, then <strong>$z$</strong>', '$5, x<b>y$, then **$z$**'],
    ['$5</b>1$', '$5</b>1$'],
    ['$AB</b>1$', '$AB</b>1$'],
  ] as const)(
    'does not classify numeric inline math as currency: %s',
    (source, expected) => {
      expect(normalizeKnownHtmlForCliMarkdown(source)).toBe(expected);
    },
  );

  it.each([
    [
      'Cost $5/item then <strong>$a<b>c$</strong>',
      'Cost $5/item then **$a<b>c$**',
    ],
    [
      'Use $HOME/bin then <strong>$a<b>c$</strong>',
      'Use $HOME/bin then **$a<b>c$**',
    ],
  ] as const)(
    'keeps slash-suffixed literal tokens separate from later math: %s',
    (source, expected) => {
      expect(normalizeKnownHtmlForCliMarkdown(source)).toBe(expected);
    },
  );

  it('does not consume the numeric prefix of later inline math as a price', () => {
    expect(normalizeKnownHtmlForCliMarkdown('Cost $5 then $10x<b>y$')).toBe(
      'Cost $5 then $10x<b>y$',
    );
  });

  it.each([
    ['$5 then $a<b>c$', '$5 then $a<b>c$'],
    ['$HOME then $a<b>c$', '$HOME then $a<b>c$'],
  ] as const)(
    'keeps a plain literal token separate from later math: %s',
    (source, expected) => {
      expect(normalizeKnownHtmlForCliMarkdown(source)).toBe(expected);
    },
  );

  it.each([
    ['<code>$HOME</code> and <code>$PATH</code>', '`$HOME` and `$PATH`'],
    ['`$HOME` <strong>or</strong> `$PATH`', '`$HOME` **or** `$PATH`'],
    ['$HOME <strong>or</strong> $PATH', '$HOME **or** $PATH'],
  ] as const)(
    'normalizes HTML between same-line shell variables: %s',
    (source, expected) => {
      const normalized = normalizeKnownHtmlForCliMarkdown(source);
      expect(normalized).toBe(expected);
      expect(normalized).not.toContain('<strong>');
      expect(normalized).not.toContain('</strong>');
    },
  );

  it.each([
    ['$HOME <strong>or</strong> $x$', '$HOME **or** $x$'],
    ['$HOME then <strong>$a<b>c$</strong>', '$HOME then **$a<b>c$**'],
    ['$HOME then <b>$a<p>c$</b>', '$HOME then **$a<p>c$**'],
    ['$HOME then <i>$a<p>c$</i>', '$HOME then _$a<p>c$_'],
    [
      'Use $HOME then <strong>$AB <p>1$</strong>',
      'Use $HOME then **$AB <p>1$**',
    ],
    ['$5 then <b>x and $y$</b>', '$5 then **x and $y$**'],
    ['$5 then <i>x and $y$</i>', '$5 then _x and $y$_'],
    ['$5 then <p>x and $y$</p>', '$5 then x and $y$'],
  ] as const)(
    'keeps a lone literal token separate from later math: %s',
    (source, expected) => {
      expect(normalizeKnownHtmlForCliMarkdown(source)).toBe(expected);
    },
  );

  it('keeps an unwrapped shell PID token separate from later math', () => {
    expect(
      normalizeKnownHtmlForCliMarkdown('PID $$ then <strong>$a<b>c$</strong>'),
    ).toBe('PID $$ then **$a<b>c$**');
  });

  it('keeps a shell-shaped math opener separate from later math', () => {
    expect(
      normalizeKnownHtmlForCliMarkdown('$AB <p>1$ <strong>and</strong> $y$'),
    ).toBe('$AB <p>1$ **and** $y$');
  });

  it('normalizes a wrapped shell token before later math', () => {
    expect(
      normalizeKnownHtmlForCliMarkdown(
        '<strong>$HOME</strong> then <strong>$a<b>c$</strong>',
      ),
    ).toBe('**$HOME** then **$a<b>c$**');
  });

  it('normalizes presentation markup before a lone trailing dollar', () => {
    expect(
      normalizeKnownHtmlForCliMarkdown('Cost $5 <strong>today</strong> $'),
    ).toBe('Cost $5 **today** $');
  });

  it.each([
    ['Use $HOME <br> $a<b>c$', 'Use $HOME \n $a<b>c$'],
    ['Use $HOME <br/> $a<b>c$', 'Use $HOME \n $a<b>c$'],
    ['Use $HOME <br /> $a<b>c$', 'Use $HOME \n $a<b>c$'],
  ] as const)(
    'recognizes supported line breaks before later math: %s',
    (source, expected) => {
      expect(normalizeKnownHtmlForCliMarkdown(source)).toBe(expected);
    },
  );

  it.each([
    ['Cost $5 <b>today</b> and $y=2$', 'Cost $5 **today** and $y=2$'],
    ['Cost $5 <i>today</i> and $y=2$', 'Cost $5 _today_ and $y=2$'],
    ['Cost $5 <p>today</p> and $y=2$', 'Cost $5 today\n\n and $y=2$'],
  ] as const)(
    'normalizes a complete one-letter wrapper before later math: %s',
    (source, expected) => {
      expect(normalizeKnownHtmlForCliMarkdown(source)).toBe(expected);
    },
  );

  it(
    'handles many unmatched one-letter wrappers without rescanning suffixes',
    { timeout: 2_000 },
    () => {
      const source = `Cost $5 ${'<b>x'.repeat(64_000)} and $y=2$`;
      expect(normalizeKnownHtmlForCliMarkdown(source)).toBe(source);
    },
  );

  it('normalizes HTML between same-line shell PID expansions', () => {
    expect(
      normalizeKnownHtmlForCliMarkdown('<code>$$</code> and <code>$$</code>'),
    ).toBe('`$$` and `$$`');
  });

  it('keeps backslash math delimiters literal inside code spans', () => {
    expect(
      normalizeKnownHtmlForCliMarkdown(
        '<code>\\(</code> <strong>or</strong> <code>\\)</code>',
      ),
    ).toBe('`\\(` **or** `\\)`');
  });

  it.each([
    ['<code>$_</code> and <code>$-</code>', '`$_` and `$-`'],
    ['<code>$10</code> and <code>$foo</code>', '`$10` and `$foo`'],
    ['<code>$HOME</code> and <code>$$</code>', '`$HOME` and `$$`'],
    ['<code>$$</code> and <code>$PATH</code>', '`$$` and `$PATH`'],
    [
      '<code>${HOME}</code> and <code>${PATH}</code>',
      '`${HOME}` and `${PATH}`',
    ],
    [
      '<code>echo $HOME</code> and <code>echo $PATH</code>',
      '`echo $HOME` and `echo $PATH`',
    ],
  ] as const)(
    'normalizes HTML between code-wrapped shell parameters: %s',
    (source, expected) => {
      expect(normalizeKnownHtmlForCliMarkdown(source)).toBe(expected);
    },
  );

  it('normalizes shell variables inside nontrivial code spans', () => {
    expect(
      normalizeKnownHtmlForCliMarkdown(
        '<code>echo $HOME</code> and <code>echo $PATH</code>',
      ),
    ).toBe('`echo $HOME` and `echo $PATH`');
  });

  it(
    'normalizes many unmatched HTML code openers without rescanning suffixes',
    { timeout: 2_000 },
    () => {
      const source = '<code>x'.repeat(64_000);
      expect(normalizeKnownHtmlForCliMarkdown(source)).toBe(
        '`x'.repeat(64_000),
      );
    },
  );

  it('normalizes shell variables inside multi-backtick code spans', () => {
    expect(
      normalizeKnownHtmlForCliMarkdown(
        '``echo $HOME`` <strong>or</strong> ``echo $PATH``',
      ),
    ).toBe('``echo $HOME`` **or** ``echo $PATH``');
  });

  it('does not replace user text resembling a generated placeholder', () => {
    expect(
      normalizeKnownHtmlForCliMarkdown(
        'literal @@CLI-LITERAL-DOLLAR-0@@ and <code>$HOME</code>',
      ),
    ).toBe('literal @@CLI-LITERAL-DOLLAR-0@@ and `$HOME`');
  });

  it('does not replace user text resembling a math placeholder', () => {
    expect(
      normalizeKnownHtmlForCliMarkdown(
        '@@LATEX-MATH-0@@ <strong>x</strong> $a<b>c$',
      ),
    ).toBe('@@LATEX-MATH-0@@ **x** $a<b>c$');
  });

  it('binds code-wrapped shell pairs to the current dollar delimiters', () => {
    expect(
      normalizeKnownHtmlForCliMarkdown(
        '<code>$HOME</code> <strong>$x$</strong> <code>$PATH</code>',
      ),
    ).toBe('`$HOME` **$x$** `$PATH`');
  });

  it.each([
    [
      '<code>$HOME</code> then <strong>$a<b>c$</strong>',
      '`$HOME` then **$a<b>c$**',
    ],
    [
      '<strong>$a<b>c$</strong> then <code>$HOME</code>',
      '**$a<b>c$** then `$HOME`',
    ],
    ['`$HOME` then <strong>$a<b>c$</strong>', '`$HOME` then **$a<b>c$**'],
  ] as const)(
    'protects math adjacent to a code-wrapped shell token: %s',
    (source, expected) => {
      expect(normalizeKnownHtmlForCliMarkdown(source)).toBe(expected);
    },
  );

  it.each([
    [
      '`${HOME:-/tmp}` <strong>or</strong> `${PATH:+x}`',
      '`${HOME:-/tmp}` **or** `${PATH:+x}`',
    ],
    [
      '<code>${HOME:=/tmp}</code> <strong>or</strong> <code>${PATH:?missing}</code>',
      '`${HOME:=/tmp}` **or** `${PATH:?missing}`',
    ],
    [
      '<code>${HOME%/usr}</code> <strong>or</strong> <code>${#PATH}</code>',
      '`${HOME%/usr}` **or** `${#PATH}`',
    ],
    [
      '${HOME%/usr} <strong>or</strong> ${#PATH}',
      '${HOME%/usr} **or** ${#PATH}',
    ],
  ] as const)(
    'normalizes HTML between compound shell expansions: %s',
    (source, expected) => {
      expect(normalizeKnownHtmlForCliMarkdown(source)).toBe(expected);
    },
  );

  it.each([
    '$0<p>1$2',
    '$0<p>1$-condition',
    '$a<b>c$d',
    '$x<i>y$z',
    '$a<br>c$',
    '$a<strong>b($c',
    '$0<p>1$$',
    '$a <b> c $b',
    '$A <b> c $B',
    '$AB<p>1$',
    '$AB <p>1$',
    '$AB<p>1$RESULT',
    '$0<p>1$-',
    '$0<p>1$RESULT',
    '$a<b>c$RESULT',
    '$x<i>y$_',
    '$a<br>c$-',
    '$5 > X <p>y</p>$2',
    '$</code>0<b>1$ trailing text$',
    '$</code>0<b>1$ trailing text`',
    '$$0 <p> 1 $$10',
  ])(
    'preserves complete inline math beside token characters: %s',
    (example) => {
      expect(normalizeKnownHtmlForCliMarkdown(example)).toBe(example);
    },
  );

  it.each(['$5 <br>1$', '$AB <strong>C$', '$5 <em>C$'])(
    'preserves complete inline math containing a supported tag: %s',
    (source) => {
      expect(normalizeKnownHtmlForCliMarkdown(source)).toBe(source);
    },
  );

  it.each(['<strong-x>x</strong-x>', '<p.foo>x</p.foo>', '<b:tag>x</b:tag>'])(
    'leaves suffixed tag-shaped text literal: %s',
    (source) => {
      expect(normalizeKnownHtmlForCliMarkdown(source)).toBe(source);
    },
  );

  it.each([
    '$HOME and $5, then <strong>run</strong> and check $PATH',
    '$HOME <strong>and</strong> $5, then run and check $PATH',
  ])('normalizes HTML among three unlike dollar tokens: %s', (example) => {
    expect(normalizeKnownHtmlForCliMarkdown(example)).toBe(
      example.replace('<strong>', '**').replace('</strong>', '**'),
    );
  });

  it('does not replace user text resembling a dollar placeholder', () => {
    expect(
      normalizeKnownHtmlForCliMarkdown(
        '@@CLI-LITERAL-DOLLAR-0@@ <code>$HOME</code>',
      ),
    ).toBe('@@CLI-LITERAL-DOLLAR-0@@ `$HOME`');
  });

  it('preserves adjacent inline math spans independently of markdown', () => {
    expect(renderPlain('$*a*$$*b*$')).toContain('$*a*$$*b*$');
    expect(renderPlain('$a_{i}$$')).toContain('$a_{i}$$');
  });

  it('preserves a complete inline span after an unmatched display opener', () => {
    expect(renderPlain('x$$y*a*$z')).toContain('x$$y*a*$z');
  });

  it('keeps every multiline math line inside an HTML blockquote', () => {
    const plain = renderPlain('<blockquote>\\[\na<b\n>0\n\\]</blockquote>', {
      colorEnabled: false,
      width: 80,
    });

    expect(plain).toContain('│ \\[\n│ a<b\n│ >0\n│ \\]');
    expect(plain).not.toContain('\n> a<b');
  });

  it('preserves comparison prose that resembles HTML attributes', () => {
    expect(renderPlain('if x <p and y>1 then z')).toContain(
      'if x <p and y>1 then z',
    );
  });

  it('continues normalizing self-closing HTML formatting tags', () => {
    const plain = renderPlain(
      '<p/>Paragraph <b/>bold <code/>code <p/ >spaced <strong/ >strong <p />before <p hidden />hidden',
    );

    expect(plain).toContain('Paragraph');
    expect(plain).toContain('bold');
    expect(plain).toContain('code');
    expect(plain).not.toContain('<p/>');
    expect(plain).not.toContain('<b/>');
    expect(plain).not.toContain('<code/>');
    expect(plain).not.toContain('<p/ >');
    expect(plain).not.toContain('<strong/ >');
    expect(plain).not.toContain('<p />');
    expect(plain).not.toContain('<p hidden />');
  });

  it('renders HTML headings as markdown headings without leaking tags', () => {
    const plain = renderPlain(
      '<h3>Verification Report</h3>The proof is <b>fully verified</b>.',
      { colorEnabled: false, width: 80 },
    );

    expect(plain).toContain('Verification Report');
    expect(plain).toContain('The proof is fully verified.');
    expect(plain).not.toContain('<h3>');
    expect(plain).not.toContain('</h3>');
    expect(plain).not.toContain('<b>');
    expect(plain).not.toContain('</b>');
  });

  it('keeps HTML headings inside HTML blockquotes quoted', () => {
    const plain = renderPlain(
      '<blockquote><h3>Quoted Report</h3><p>The proof is <b>fully verified</b>.</p></blockquote>',
      { colorEnabled: false, width: 80 },
    );

    expect(plain).toContain('│ ### Quoted Report');
    expect(plain).toContain('│ The proof is fully verified.');
    expect(plain).not.toContain('\nQuoted Report');
    expect(plain).not.toContain('<blockquote>');
    expect(plain).not.toContain('<h3>');
    expect(plain).not.toContain('<b>');
  });

  it('summarizes embedded subagent result XML before HTML rendering', () => {
    const plain = renderPlain(
      [
        '<blockquote>',
        '<subagent-result id="abc" agent="review" category="toolUse" status="completed">',
        '<wall-time>2m</wall-time>',
        '<response>All good &lt;ok&gt;</response>',
        '</subagent-result>',
        '</blockquote>',
      ].join('\n'),
      { colorEnabled: false, width: 80 },
    );

    expect(plain).toContain('│ ✓ review completed · 2m');
    expect(plain).toContain('│ All good <ok>');
    expect(plain).not.toContain('<subagent-result');
    expect(plain).not.toContain('<response>');
    expect(plain).not.toContain('<blockquote>');
  });

  it('passes typed code through cli-highlight without leaking sentinels', () => {
    const md = '```ts\nconst x: number = 1;\n```';
    const out = renderAnsiMarkdown(md);
    expect(out).toContain('const');
    expect(out).toContain('number');
    expect(out).not.toContain('ANSI_FENCE_OPEN');
    expect(out).not.toContain('ANSI_FENCE_CLOSE');
  });

  it('falls back to dim grey for unknown languages', () => {
    const out = renderAnsiMarkdown('```nosuchlang\nplain body\n```');
    expect(out).toContain('plain body');
    expect(out).not.toContain('ANSI_FENCE');
  });

  it('prefixes every rendered blockquote line', () => {
    const plain = renderPlain('> first\n> second\n>\n> third');
    expect(plain).toContain('│ first\n│ second');
    expect(plain).toContain('│ third');
  });

  it('keeps multiline math inside a Markdown blockquote', () => {
    const plain = renderPlain('> \\[\n> a+b\n> \\]', {
      colorEnabled: false,
      width: 80,
    });

    expect(plain).toContain('│ \\[\n│ a+b\n│ \\]');
    expect(plain).not.toContain('\n> a+b');
  });

  it('keeps lazy multiline math continuation inside a Markdown blockquote', () => {
    const plain = renderPlain('> \\[\n  a+b\n> \\]', {
      colorEnabled: false,
      width: 80,
    });

    expect(plain).toContain('│ \\[\n│   a+b\n│ \\]');
    expect(plain).not.toContain('\n> \\]');
  });

  it('strips a partial lazy prefix inside a nested Markdown blockquote', () => {
    const plain = renderPlain('> > \\[\n> a+b\n> > \\]', {
      colorEnabled: false,
      width: 80,
    });

    expect(plain).toContain('│ │ \\[\n│ │ a+b\n│ │ \\]');
    expect(plain).not.toContain('│ │ > a+b');
  });

  it('keeps multiline math inside a quoted list item', () => {
    const plain = renderPlain('> - \\[\n>   a+b\n>   \\]', {
      colorEnabled: false,
      width: 80,
    });

    expect(plain).toContain('│   • \\[\n│   a+b\n│   \\]');
    expect(plain).not.toContain('\n>   a+b');
  });

  it('keeps multiline math inside a blockquote nested under a list', () => {
    const plain = renderPlain('- > \\[\n  > a+b\n  > \\]', {
      colorEnabled: false,
      width: 80,
    });

    expect(plain).toContain('│ \\[');
    expect(plain).toContain('│ a+b');
    expect(plain).toContain('│ \\]');
    expect(plain).not.toContain('\n  > a+b');
  });

  it('keeps multiline math through an alternating quote-list chain', () => {
    const plain = renderPlain('> - > \\[\n>   > a+b\n>   > \\]', {
      colorEnabled: false,
      width: 80,
    });
    const mathLine = plain.split('\n').find((line) => line.includes('a+b'));

    expect(mathLine).toBeDefined();
    expect([...(mathLine ?? '')].filter((char) => char === '│')).toHaveLength(
      2,
    );
    expect(mathLine).not.toContain('>');
  });

  it('renders nested blockquote prefixes once per depth', () => {
    const plain = renderPlain('> outer\n> > inner');
    expect(plain).toContain('│ outer');
    expect(plain).toContain('│ │ inner');
    expect(plain).not.toContain('│ │ │ inner');
  });

  it('keeps the blockquote gutter on tight lists inside the quote', () => {
    const plain = renderPlain('> - item 1\n> - item 2');
    // First bullet inherits the gutter from blockquote_open; the second
    // bullet must re-inject it so it doesn't render at column 0.
    expect(plain).toContain('│   • item 1');
    expect(plain).toContain('│   • item 2');
    // Mid-line gutter would mean `│   • │ item` — guard against regression.
    expect(plain).not.toMatch(/•\s+│/);
  });

  it('keeps the blockquote gutter on quoted block nodes', () => {
    const plain = renderPlain(
      '> # Heading\n>\n> ```ts\n> const x = 1;\n> const y = 2;\n> ```\n>\n> ---',
    );
    expect(plain).toContain('│ Heading');
    expect(plain).toContain('│ const x = 1;');
    expect(plain).toContain('│ const y = 2;');
    expect(plain).toContain('│ ─');
  });

  it('preserves ordered-list delimiter markup', () => {
    const plain = renderPlain('1) one\n2) two');
    expect(plain).toContain('1) one');
    expect(plain).toContain('2) two');
  });

  it('renders headings without visible Markdown markers', () => {
    const plain = renderPlain(
      '## What is a Tensor Network?\n\n### Core objects',
    );
    expect(plain).toContain('What is a Tensor Network?');
    expect(plain).toContain('Core objects');
    expect(plain).not.toContain('## What');
    expect(plain).not.toContain('### Core');
  });

  it('re-emits heading markers only when color is disabled', () => {
    expect(renderPlain('## Section')).not.toContain('## Section');
    expect(renderAnsiMarkdown('## Section', { colorEnabled: false })).toContain(
      '## Section',
    );
  });

  it('styles heading levels distinctly', () => {
    const h1 = renderAnsiMarkdown('# Title');
    const h2 = renderAnsiMarkdown('## Title');
    const h3 = renderAnsiMarkdown('### Title');
    expect(h1).toContain(`${ESC}[4m`);
    expect(h2).not.toContain(`${ESC}[4m`);
    expect(h2).toContain(`${ESC}[36m`);
    expect(h3).not.toContain(`${ESC}[36m`);
    expect(h3).toContain(`${ESC}[1m`);
  });

  it('indents nested list items deeper than their parents', () => {
    const plain = renderPlain('- parent\n  - child');
    expect(plain).toContain('  • parent');
    expect(plain).toContain('    • child');
  });

  it('keeps nested-list indent on wrapped continuation lines', () => {
    const lines = renderPlain('- parent\n  - abcdef ghijkl mnopqr', {
      width: 12,
    }).split('\n');
    const childIndex = lines.findIndex((line) => line.includes('• abcdef'));
    expect(childIndex).toBeGreaterThan(-1);
    expect(lines[childIndex]).toMatch(/^ {4}• /);
    const continuations = lines
      .slice(childIndex + 1)
      .filter((line) => line.trim().length > 0);
    expect(continuations.length).toBeGreaterThan(0);
    for (const line of continuations) expect(line).toMatch(/^ {6}/);
  });

  it('appends link destinations that differ from the link text', () => {
    const plain = renderPlain('[docs](https://example.com/x)', {
      colorEnabled: false,
    });
    expect(plain).toContain('[docs] (https://example.com/x)');
  });

  it('does not duplicate autolinked destinations', () => {
    const plain = renderPlain('Visit example.com and <https://a.io>', {
      colorEnabled: false,
    });
    expect(plain).not.toContain('(http://example.com)');
    expect(plain).not.toContain('(https://a.io)');
  });

  it('renders markdown without ANSI styles when color is disabled', () => {
    const out = renderAnsiMarkdown(
      '**Bold** and _emphasis_ with `code`.\n\n```ts\nconst x = 1;\n```',
      { colorEnabled: false },
    );

    expect(out).toContain('Bold and emphasis with `code`.');
    expect(out).toContain('const x = 1;');
    expect(out).not.toMatch(ANSI_SGR_PATTERN);
  });

  it('separates consecutive paragraphs visually', () => {
    const plain = renderPlain('First paragraph.\n\nSecond paragraph.');
    expect(plain).toContain('First paragraph.\n\nSecond paragraph.');
  });

  it('wraps rendered markdown at display-cell boundaries', () => {
    const lines = plainLinesWithinWidth(
      renderAnsiMarkdown('你好🙂abcdef', { width: 6 }),
      6,
    );
    expect(lines.length).toBeGreaterThan(1);
  });

  it('keeps blockquote gutters on wrapped continuation lines', () => {
    const lines = plainLinesWithinWidth(
      renderAnsiMarkdown('> abcdef ghijkl mnopqr', { width: 10 }),
      10,
    );
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line).toMatch(/^│ /);
    }
  });

  it('keeps list indentation on wrapped continuation lines', () => {
    const lines = plainLinesWithinWidth(
      renderAnsiMarkdown('- abcdef ghijkl mnopqr', { width: 10 }),
      10,
    );
    expect(lines[0]).toMatch(/^ {2}• /);
    expect(lines.slice(1).every((line) => line.startsWith('    '))).toBe(true);
  });

  it('styles heading text across inline code boundaries', () => {
    const plain = renderPlain('## Use `git` correctly');
    expect(plain).toContain('Use `git` correctly');
    expect(plain).not.toContain('## Use');
  });

  it('renders GFM pipe tables as a box-drawing table, not raw HTML', () => {
    const md = '| Dimension | Workflow |\n|---|---|\n| Output | Rewrites |';
    const plain = renderPlain(md);
    // The cells render…
    expect(plain).toContain('Dimension');
    expect(plain).toContain('Rewrites');
    // …inside an actual table, with no markdown-it HTML fallback leaking.
    expect(plain).toMatch(/[┌┬┐├┼┤└┴┘─│]/);
    expect(plain).not.toContain('<table>');
    expect(plain).not.toContain('<td>');
    expect(plain).not.toContain('<th>');
  });

  it('keeps a table within the requested width', () => {
    const md =
      '| Col A | Col B | Col C |\n|---|---|---|\n' +
      '| a fairly long cell value | another long one | third column here |';
    plainLinesWithinWidth(renderAnsiMarkdown(md, { width: 40 }), 40);
  });

  it('wraps ordinary prose table cells at word boundaries', () => {
    const md = '| Words |\n|---|\n| alpha beta gamma delta |';
    const cells = renderPlain(md, { width: 16 })
      .split('\n')
      .filter((line) => line.startsWith('│'))
      .map((line) => line.split('│')[1]?.trim());

    expect(cells).toContain('alpha beta');
    expect(cells).toContain('gamma delta');
  });

  it('preserves long unbroken LaTeX cells in width-constrained tables', () => {
    const heading = '$\\operatorname{eig}(\\rho_{\\mathcal{A}_\\gamma}^{T_B})$';
    const spectrum = '$\\{-\\tfrac12,\\tfrac12,\\tfrac12,\\tfrac12\\}$';
    const fullwidth = '量'.repeat(20);
    const md = [
      `| $\\gamma$ | $\\operatorname{eig}(\\rho_{\\mathcal A_\\gamma})$ | ${heading} |`,
      '|---|---|---|',
      `| $0$ | $\\{0,0,0,1\\}$ | ${spectrum} |`,
      `| $1$ | channel | ${fullwidth} |`,
    ].join('\n');
    const rendered = renderAnsiMarkdown(md, {
      width: 100,
      colorEnabled: true,
    });
    const lines = plainLinesWithinWidth(rendered, 100);
    const thirdColumn = lines
      .filter((line) => line.startsWith('│'))
      .map((line) => line.split('│')[3] ?? '')
      .join('')
      .replaceAll(/\s/gu, '');

    expect(thirdColumn).toContain(heading.replaceAll(/\s/gu, ''));
    expect(thirdColumn).toContain(spectrum);
    expect(thirdColumn).toContain(fullwidth);
    expect(lines.join('\n')).not.toContain('…');
    expect(
      rendered.replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, 'gu'), ''),
    ).not.toContain(ESC);
  });

  it('sizes a small table to its content instead of stretching to full width', () => {
    const md = '| n | digits |\n|---|---|\n| 447 | 993.3 |';
    const plain = renderPlain(md, { width: 80 });
    const widest = Math.max(
      ...plain.split('\n').map((line) => displayWidthForTest(line)),
    );
    // Content needs only a handful of columns — it must not balloon to 80.
    expect(widest).toBeLessThan(24);
    expect(widest).toBeGreaterThan(0);
    expect(plain).toContain('447');
    expect(plain).toContain('993.3');
  });

  it('does not leak protected LaTeX placeholders from wrapped table cells', () => {
    const md = [
      '| Seed | n=0 | n=1 | Next exceeds bound? |',
      '|---|---|---|---|',
      '| $3+\\sqrt{5}$ | \\((3,1)\\) | \\((47,21)\\) | $123 > 100$ (stop) |',
    ].join('\n');
    const plain = renderPlain(md, { width: 52 });
    expect(plain).not.toContain('@@LATEX');
    expect(plain).toContain('$3+\\sqrt{');
    expect(plain).toContain('\\((47,21)');
  });

  it('memoises identical inputs (second call hits the cache)', () => {
    const first = renderAnsiMarkdown('# Title\n\nParagraph.');
    const before = _ansiMarkdownStatsForTests();
    const second = renderAnsiMarkdown('# Title\n\nParagraph.');
    const after = _ansiMarkdownStatsForTests();
    expect(second).toBe(first);
    // The second call must hit the cache, not re-render through markdown-it.
    expect(after.hits - before.hits).toBe(1);
    expect(after.misses - before.misses).toBe(0);
  });

  // Regression: without a math plugin, markdown-it corrupts LaTeX inside math
  // spans — its escape rule strips `\(`→`(`, `\;`→`;`, `\{`→`{`, and its
  // emphasis rule eats `_{…}` subscripts. The CLI shows LaTeX source verbatim,
  // so whole spans must survive untouched.
  it('preserves \\(…\\) and \\[…\\] math delimiter spans verbatim', () => {
    const plain = renderPlain(
      'Euler: \\(e^{i\\pi}+1=0\\) and \\[a \\; = \\; b\\] done',
    );
    expect(plain).toContain('\\(e^{i\\pi}+1=0\\)');
    expect(plain).toContain('\\[a \\; = \\; b\\]');
  });

  it('preserves $…$ and $$…$$ spans incl. subscripts (no emphasis) and backslash-braces', () => {
    const plain = renderPlain(
      'Pairs $a_{i}b_{j}$ and $$P_k = \\{2k-1,\\; 2k\\}$$ end',
    );
    // emphasis rule must NOT fire inside the math span
    expect(plain).toContain('$a_{i}b_{j}$');
    expect(plain).not.toContain('<em>');
    // display span with backslash-braces and a thin-space survives whole
    expect(plain).toContain('$$P_k = \\{2k-1,\\; 2k\\}$$');
  });

  it('nets stray spacing macros / literal braces outside any math span', () => {
    const plain = renderPlain('loose \\; macro and set \\{1,2\\}');
    expect(plain).toContain('\\;');
    expect(plain).toContain('\\{1,2\\}');
  });

  it('does not replace user text resembling a LaTeX macro placeholder', () => {
    const plain = renderPlain('literal @@LATEX-MACRO-0@@ and \\;');
    expect(plain).toContain('literal @@LATEX-MACRO-0@@ and \\;');
  });

  it('still honours genuine markdown backslash-escapes outside the LaTeX set', () => {
    const plain = renderPlain('a \\* b and \\$ c');
    // `\*` and `\$` carry real markdown-escape meaning — leave them stripped.
    expect(plain).toContain('a * b and $ c');
    expect(plain).not.toContain('\\*');
  });

  // Regression for the Cursor Bugbot finding: an escaped `\$` (a literal dollar
  // in LaTeX) must not be treated as a closing `$` delimiter, or it mis-splits
  // the span and cascades into later `$`. With both delimiters guarded, the
  // fragment isn't protected — markdown handles `\$` → `$` instead.
  it('does not treat an escaped \\$ as a closing math delimiter', () => {
    const plain = renderPlain('A price $a = \\$5$ here');
    expect(plain).not.toContain('$a = \\$');
    expect(plain).toContain('here');
  });
});
