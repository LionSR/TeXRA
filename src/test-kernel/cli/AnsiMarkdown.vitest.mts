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
import { wrapAnsiToWidth } from '@cli/tui/ansiWrap';

const ANSI_SGR_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;]*m`,
  'u',
);

function displayWidthForTest(line: string): number {
  let width = 0;
  for (const char of line) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (
      (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
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

  it('renders common HTML formatting without leaking tags', () => {
    const out = renderAnsiMarkdown(
      [
        '<blockquote><strong>Subagent <code>prover</code> finished execution abc:</strong>',
        '',
        'Done.</blockquote>',
      ].join('\n'),
      { colorEnabled: false, width: 80 },
    );
    const plain = stripAnsi(out);

    expect(plain).toContain('│ Subagent `prover` finished execution abc:');
    expect(plain).toContain('│ Done.');
    expect(plain).not.toContain('<blockquote>');
    expect(plain).not.toContain('<strong>');
    expect(plain).not.toContain('<code>');
  });

  it('renders HTML headings as markdown headings without leaking tags', () => {
    const out = renderAnsiMarkdown(
      '<h3>Verification Report</h3>The proof is <b>fully verified</b>.',
      { colorEnabled: false, width: 80 },
    );
    const plain = stripAnsi(out);

    expect(plain).toContain('Verification Report');
    expect(plain).toContain('The proof is fully verified.');
    expect(plain).not.toContain('<h3>');
    expect(plain).not.toContain('</h3>');
    expect(plain).not.toContain('<b>');
    expect(plain).not.toContain('</b>');
  });

  it('keeps HTML headings inside HTML blockquotes quoted', () => {
    const out = renderAnsiMarkdown(
      '<blockquote><h3>Quoted Report</h3><p>The proof is <b>fully verified</b>.</p></blockquote>',
      { colorEnabled: false, width: 80 },
    );
    const plain = stripAnsi(out);

    expect(plain).toContain('│ Quoted Report');
    expect(plain).toContain('│ The proof is fully verified.');
    expect(plain).not.toContain('\nQuoted Report');
    expect(plain).not.toContain('<blockquote>');
    expect(plain).not.toContain('<h3>');
    expect(plain).not.toContain('<b>');
  });

  it('summarizes embedded subagent result XML before HTML rendering', () => {
    const out = renderAnsiMarkdown(
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
    const plain = stripAnsi(out);

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
    const out = renderAnsiMarkdown('> first\n> second\n>\n> third');
    const plain = stripAnsi(out);
    expect(plain).toContain('│ first\n│ second');
    expect(plain).toContain('│ third');
  });

  it('renders nested blockquote prefixes once per depth', () => {
    const out = renderAnsiMarkdown('> outer\n> > inner');
    const plain = stripAnsi(out);
    expect(plain).toContain('│ outer');
    expect(plain).toContain('│ │ inner');
    expect(plain).not.toContain('│ │ │ inner');
  });

  it('keeps the blockquote gutter on tight lists inside the quote', () => {
    const out = renderAnsiMarkdown('> - item 1\n> - item 2');
    const plain = stripAnsi(out);
    // First bullet inherits the gutter from blockquote_open; the second
    // bullet must re-inject it so it doesn't render at column 0.
    expect(plain).toContain('│   • item 1');
    expect(plain).toContain('│   • item 2');
    // Mid-line gutter would mean `│   • │ item` — guard against regression.
    expect(plain).not.toMatch(/•\s+│/);
  });

  it('keeps the blockquote gutter on quoted block nodes', () => {
    const out = renderAnsiMarkdown(
      '> # Heading\n>\n> ```ts\n> const x = 1;\n> const y = 2;\n> ```\n>\n> ---',
    );
    const plain = stripAnsi(out);
    expect(plain).toContain('│ Heading');
    expect(plain).toContain('│ const x = 1;');
    expect(plain).toContain('│ const y = 2;');
    expect(plain).toContain('│ ─');
  });

  it('preserves ordered-list delimiter markup', () => {
    const out = renderAnsiMarkdown('1) one\n2) two');
    expect(stripAnsi(out)).toContain('1) one');
    expect(stripAnsi(out)).toContain('2) two');
  });

  it('renders headings without visible Markdown markers', () => {
    const out = renderAnsiMarkdown(
      '## What is a Tensor Network?\n\n### Core objects',
    );
    const plain = stripAnsi(out);
    expect(plain).toContain('What is a Tensor Network?');
    expect(plain).toContain('Core objects');
    expect(plain).not.toContain('## What');
    expect(plain).not.toContain('### Core');
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
    const out = renderAnsiMarkdown('First paragraph.\n\nSecond paragraph.');
    expect(stripAnsi(out)).toContain('First paragraph.\n\nSecond paragraph.');
  });

  it('wraps rendered markdown at display-cell boundaries', () => {
    const out = renderAnsiMarkdown('你好🙂abcdef', { width: 6 });
    const lines = stripAnsi(out).split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(displayWidthForTest(line)).toBeLessThanOrEqual(6);
    }
  });

  it('keeps blockquote gutters on wrapped continuation lines', () => {
    const out = renderAnsiMarkdown('> abcdef ghijkl mnopqr', { width: 10 });
    const plain = stripAnsi(out);
    const lines = plain.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line).toMatch(/^│ /);
      expect(displayWidthForTest(line)).toBeLessThanOrEqual(10);
    }
  });

  it('keeps list indentation on wrapped continuation lines', () => {
    const out = renderAnsiMarkdown('- abcdef ghijkl mnopqr', { width: 10 });
    const plain = stripAnsi(out);
    const lines = plain.split('\n');
    expect(lines[0]).toMatch(/^ {2}• /);
    expect(lines.slice(1).every((line) => line.startsWith('    '))).toBe(true);
    for (const line of lines) {
      expect(displayWidthForTest(line)).toBeLessThanOrEqual(10);
    }
  });

  it('keeps quoted list prefixes aligned across ANSI charset escapes', () => {
    const esc = String.fromCharCode(27);
    const line = `${esc}(0│ ${esc}(B  • abcdef ghijkl mnopqr`;
    const out = wrapAnsiToWidth(line, 10, true);
    const plain = stripAnsi(out);
    const lines = plain.split('\n');

    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toBe('│   • abcd');
    expect(lines.slice(1).every((line) => line.startsWith('│     '))).toBe(
      true,
    );
    expect(plain).not.toContain('0│');
    expect(plain).not.toContain('B  •');
    for (const wrappedLine of lines) {
      expect(displayWidthForTest(wrappedLine)).toBeLessThanOrEqual(10);
    }
  });

  it('wraps quoted list prefixes after C1-ST OSC hyperlinks', () => {
    const esc = String.fromCharCode(27);
    const c1StringTerminator = String.fromCharCode(0x9c);
    const link = `${esc}]8;;https://example.test${c1StringTerminator}`;
    const out = wrapAnsiToWidth(`${link}│   • abcdef ghijkl mnopqr`, 10, true);
    const plain = stripAnsi(out);
    const lines = plain.split('\n');

    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toBe('│   • abcd');
    expect(lines.slice(1).every((line) => line.startsWith('│     '))).toBe(
      true,
    );
    for (const wrappedLine of lines) {
      expect(displayWidthForTest(wrappedLine)).toBeLessThanOrEqual(10);
    }
  });

  it('wraps quoted list prefixes after C1 CSI styles', () => {
    const c1Csi = String.fromCharCode(0x9b);
    const out = wrapAnsiToWidth(
      `${c1Csi}31m│ ${c1Csi}39m  • abcdef ghijkl mnopqr`,
      10,
      true,
    );
    const plain = stripAnsi(out);
    const lines = plain.split('\n');

    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toBe('│   • abcd');
    expect(lines.slice(1).every((line) => line.startsWith('│     '))).toBe(
      true,
    );
    expect(plain).not.toContain('31m');
    expect(plain).not.toContain('39m');
    for (const wrappedLine of lines) {
      expect(displayWidthForTest(wrappedLine)).toBeLessThanOrEqual(10);
    }
  });

  it('styles heading text across inline code boundaries', () => {
    const out = renderAnsiMarkdown('## Use `git` correctly');
    const plain = stripAnsi(out);
    expect(plain).toContain('Use `git` correctly');
    expect(plain).not.toContain('## Use');
  });

  it('keeps OSC hyperlinks balanced when wrapping ANSI text', () => {
    const esc = String.fromCharCode(27);
    const bel = String.fromCharCode(7);
    const open = `${esc}]8;;https://example.com${esc}\\`;
    const close = `${esc}]8;;${esc}\\`;
    const closeWithBel = `${esc}]8;;${bel}`;
    const out = wrapAnsiToWidth(`${open}hello world${close}`, 5);
    const plain = stripAnsi(out);
    expect(plain.replaceAll('\n', '')).toBe('hello world');
    for (const line of plain.split('\n')) {
      expect(displayWidthForTest(line)).toBeLessThanOrEqual(5);
    }
    const openCount = out.split(`${esc}]8;;https://example.com`).length - 1;
    const closeCount =
      out.split(close).length - 1 + (out.split(closeWithBel).length - 1);
    expect(openCount).toBe(closeCount);
    expect(out).toContain(open);
    expect(out).toContain(close);
  });

  it('wraps diff lines with the same ANSI-aware width helper', () => {
    const out = wrapAnsiToWidth('+你好🙂abcdef', 6);
    const lines = stripAnsi(out).split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(displayWidthForTest(line)).toBeLessThanOrEqual(6);
    }
  });

  it('renders GFM pipe tables as a box-drawing table, not raw HTML', () => {
    const md = '| Dimension | Workflow |\n|---|---|\n| Output | Rewrites |';
    const out = renderAnsiMarkdown(md);
    const plain = stripAnsi(out);
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
    const out = renderAnsiMarkdown(md, { width: 40 });
    for (const line of stripAnsi(out).split('\n')) {
      expect(displayWidthForTest(line)).toBeLessThanOrEqual(40);
    }
  });

  it('sizes a small table to its content instead of stretching to full width', () => {
    const md = '| n | digits |\n|---|---|\n| 447 | 993.3 |';
    const out = renderAnsiMarkdown(md, { width: 80 });
    const widest = Math.max(
      ...stripAnsi(out)
        .split('\n')
        .map((line) => displayWidthForTest(line)),
    );
    // Content needs only a handful of columns — it must not balloon to 80.
    expect(widest).toBeLessThan(24);
    expect(widest).toBeGreaterThan(0);
    expect(stripAnsi(out)).toContain('447');
    expect(stripAnsi(out)).toContain('993.3');
  });

  it('does not leak protected LaTeX placeholders from wrapped table cells', () => {
    const md = [
      '| Seed | n=0 | n=1 | Next exceeds bound? |',
      '|---|---|---|---|',
      '| $3+\\sqrt{5}$ | \\((3,1)\\) | \\((47,21)\\) | $123 > 100$ (stop) |',
    ].join('\n');
    const out = renderAnsiMarkdown(md, { width: 52 });
    const plain = stripAnsi(out);
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
    const out = stripAnsi(
      renderAnsiMarkdown(
        'Euler: \\(e^{i\\pi}+1=0\\) and \\[a \\; = \\; b\\] done',
      ),
    );
    expect(out).toContain('\\(e^{i\\pi}+1=0\\)');
    expect(out).toContain('\\[a \\; = \\; b\\]');
  });

  it('preserves $…$ and $$…$$ spans incl. subscripts (no emphasis) and backslash-braces', () => {
    const out = stripAnsi(
      renderAnsiMarkdown(
        'Pairs $a_{i}b_{j}$ and $$P_k = \\{2k-1,\\; 2k\\}$$ end',
      ),
    );
    // emphasis rule must NOT fire inside the math span
    expect(out).toContain('$a_{i}b_{j}$');
    expect(out).not.toContain('<em>');
    // display span with backslash-braces and a thin-space survives whole
    expect(out).toContain('$$P_k = \\{2k-1,\\; 2k\\}$$');
  });

  it('nets stray spacing macros / literal braces outside any math span', () => {
    const out = stripAnsi(
      renderAnsiMarkdown('loose \\; macro and set \\{1,2\\}'),
    );
    expect(out).toContain('\\;');
    expect(out).toContain('\\{1,2\\}');
  });

  it('still honours genuine markdown backslash-escapes outside the LaTeX set', () => {
    const out = stripAnsi(renderAnsiMarkdown('a \\* b and \\$ c'));
    // `\*` and `\$` carry real markdown-escape meaning — leave them stripped.
    expect(out).toContain('a * b and $ c');
    expect(out).not.toContain('\\*');
  });

  // Regression for the Cursor Bugbot finding: an escaped `\$` (a literal dollar
  // in LaTeX) must not be treated as a closing `$` delimiter, or it mis-splits
  // the span and cascades into later `$`. With both delimiters guarded, the
  // fragment isn't protected — markdown handles `\$` → `$` instead.
  it('does not treat an escaped \\$ as a closing math delimiter', () => {
    const out = stripAnsi(renderAnsiMarkdown('A price $a = \\$5$ here'));
    expect(out).not.toContain('$a = \\$');
    expect(out).toContain('here');
  });
});
