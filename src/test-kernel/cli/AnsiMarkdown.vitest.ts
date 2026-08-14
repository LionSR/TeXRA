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

  it('preserves TeX inequalities that resemble opening HTML tags', () => {
    const examples = [
      '\\[0<p<1\\]',
      '\\[0<p>1\\]',
      '\\[a<b>c\\]',
      '\\[a<i>c\\]',
      '\\[a<br>c\\]',
      '\\(0 < p < 1\\)',
      '\\(0 <p <1\\)',
      '\\(0 <p < 1\\)',
      '\\(0 <p > 1\\)',
      '\\(0 <p> 1\\)',
      '\\(if x <p and y>1 then z\\)',
    ];

    for (const example of examples) {
      expect(renderPlain(example)).toContain(example);
    }
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

  it('preserves comparison prose that resembles HTML attributes', () => {
    expect(renderPlain('if x <p and y>1 then z')).toContain(
      'if x <p and y>1 then z',
    );
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
