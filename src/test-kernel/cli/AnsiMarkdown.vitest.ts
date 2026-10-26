// Smoke test for the CLI TUI's ANSI markdown renderer (Phase 3).
//
// We don't snapshot the exact ANSI bytes — that locks the layout in too hard.
// Instead, verify the renderer (a) preserves raw text, (b) doesn't HTML-escape
// inside fenced code, (c) routes through the shared factory + cache without
// crashing, and (d) keeps implementation markers out of the final output.

import { describe, expect, it } from 'vitest';
import stripAnsi from 'strip-ansi';

import { renderAnsiMarkdown } from '@cli/chat/tui/render/ansiMarkdown';
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

/** Normalizes and renders markdown the way a transcript row does, then strips
 *  ANSI, for assertions on the visible text. */
function renderPlain(markdown: string, options?: RenderOptions): string {
  return stripAnsi(
    renderAnsiMarkdown(normalizeKnownHtmlForCliMarkdown(markdown), options),
  );
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
  it('renders plain prose with no HTML escapes', () => {
    const out = renderAnsiMarkdown('Hello <world>');
    expect(out).toContain('Hello <world>');
    expect(out).not.toContain('&lt;');
    expect(out).not.toContain('&gt;');
  });

  it('renders common HTML formatting without leaking tags', () => {
    const plain = renderPlain(
      [
        '<blockquote class="result"><strong data-kind="agent">Subagent <code title=tool>prover</code> finished run abc:</strong>',
        '',
        'Done.</blockquote>',
      ].join('\n'),
      { colorEnabled: false, width: 80 },
    );

    expect(plain).toContain('│ Subagent `prover` finished run abc:');
    expect(plain).toContain('│ Done.');
    expect(plain).not.toContain('<blockquote');
    expect(plain).not.toContain('<strong');
    expect(plain).not.toContain('<code');
  });

  it.each([
    '\\[0<p<1\\]',
    '\\[a<b>c\\]',
    '\\[0<p<1, 1-\\frac{2p}{3}>0, \\frac p3>0\\]',
    '$0<p>1$',
    '\\(0 < p < 1\\)',
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

  it('rejects a long invalid valueless attribute without changing the text', () => {
    const source = `<p${' '.repeat(20_000)}x>`;
    expect(normalizeKnownHtmlForCliMarkdown(source)).toBe(source);
  });

  it.each([
    'Cost $5 <strong>today</strong>, then $10',
    'Cost US$5 <strong>today</strong>, then US$10',
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
    ['$5, x<b>y$', '$5, x<b>y$'],
    ['$5, x<b>y$, then <strong>$z$</strong>', '$5, x<b>y$, then **$z$**'],
    ['$5</b>1$', '$5</b>1$'],
  ] as const)(
    'does not classify numeric inline math as currency: %s',
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
    ['$foo then <strong>$a<b>c$</strong>', '$foo then **$a<b>c$**'],
    ['$HOME then <b>$a<p>c$</b>', '$HOME then **$a<p>c$**'],
    [
      'Use $HOME then <strong>$AB <p>1$</strong>',
      'Use $HOME then **$AB <p>1$**',
    ],
    ['$5 then <b>x and $y$</b>', '$5 then **x and $y$**'],
    ['$5 then <p>x and $y$</p>', '$5 then x and $y$'],
  ] as const)(
    'keeps a lone literal token separate from later math: %s',
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
    '$a<b>c$d',
    '$a<strong>b($c',
    '$0<p>1$$',
    '$a <b> c $b',
    '$AB<p>1$',
    '$5 > X <p>y</p>$2',
    '$</code>0<b>1$ trailing text$',
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

  it('preserves adjacent inline math spans independently of markdown', () => {
    expect(renderPlain('$*a*$$*b*$')).toContain('$*a*$$*b*$');
    expect(renderPlain('$a_{i}$$')).toContain('$a_{i}$$');
  });

  it('keeps every multiline math line inside an HTML blockquote', () => {
    const plain = renderPlain('<blockquote>\\[\na<b\n>0\n\\]</blockquote>', {
      colorEnabled: false,
      width: 80,
    });

    expect(plain).toContain('│ \\[\n│ a<b\n│ >0\n│ \\]');
    expect(plain).not.toContain('\n> a<b');
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

  it('keeps multiline math inside a Markdown blockquote', () => {
    const plain = renderPlain('> \\[\n> a+b\n> \\]', {
      colorEnabled: false,
      width: 80,
    });

    expect(plain).toContain('│ \\[\n│ a+b\n│ \\]');
    expect(plain).not.toContain('\n> a+b');
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

  it('renders markdown without ANSI styles when color is disabled', () => {
    const out = renderAnsiMarkdown(
      '**Bold** and _emphasis_ with `code`.\n\n```ts\nconst x = 1;\n```',
      { colorEnabled: false },
    );

    expect(out).toContain('Bold and emphasis with `code`.');
    expect(out).toContain('const x = 1;');
    expect(out).not.toMatch(ANSI_SGR_PATTERN);
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

  it('still honours genuine markdown backslash-escapes outside the LaTeX set', () => {
    const plain = renderPlain('a \\* b and \\$ c');
    // `\*` and `\$` carry real markdown-escape meaning — leave them stripped.
    expect(plain).toContain('a * b and $ c');
    expect(plain).not.toContain('\\*');
  });

  // Regression for the Cursor Bugbot finding: an escaped `\$` inside a span is
  // part of the texmath body, not a closing delimiter. texmath's `dollars`
  // rule spans `$a = \$5$` as one math block (its body permits interior `$`),
  // so the CLI shield must keep the whole span verbatim instead of letting
  // markdown turn `\$` into `$` and mis-splitting later dollars. The fixture
  // uses a doubled backslash so the runtime string contains a real `\$`.
  it('keeps an escaped \\$ inside an inline math span verbatim', () => {
    const plain = renderPlain('A price $a = \\$5$ here');
    expect(plain).toContain('$a = \\$5$');
    expect(plain).toContain('here');
  });
});
