// Smoke test for the CLI TUI's ANSI markdown renderer (Phase 3).
//
// We don't snapshot the exact ANSI bytes — that locks the layout in too hard.
// Instead, verify the renderer (a) preserves raw text, (b) doesn't HTML-escape
// inside fenced code, (c) routes through the shared factory + cache without
// crashing, and (d) keeps implementation markers out of the final output.

import { describe, expect, it } from 'vitest';
import stripAnsi from 'strip-ansi';

import {
  _ansiMarkdownStatsForTests,
  _resetAnsiMarkdownForTests,
  renderAnsiMarkdown,
} from '@cli/chat/tui/render/ansiMarkdown';
import { wrapAnsiToWidth } from '@cli/chat/tui/render/ansiWrap';

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
  it('renders plain prose with no HTML escapes', () => {
    _resetAnsiMarkdownForTests();
    const out = renderAnsiMarkdown('Hello <world>');
    expect(out).toContain('Hello <world>');
    expect(out).not.toContain('&lt;');
    expect(out).not.toContain('&gt;');
  });

  it('passes typed code through cli-highlight without leaking sentinels', () => {
    _resetAnsiMarkdownForTests();
    const md = '```ts\nconst x: number = 1;\n```';
    const out = renderAnsiMarkdown(md);
    expect(out).toContain('const');
    expect(out).toContain('number');
    expect(out).not.toContain('ANSI_FENCE_OPEN');
    expect(out).not.toContain('ANSI_FENCE_CLOSE');
  });

  it('falls back to dim grey for unknown languages', () => {
    _resetAnsiMarkdownForTests();
    const out = renderAnsiMarkdown('```nosuchlang\nplain body\n```');
    expect(out).toContain('plain body');
    expect(out).not.toContain('ANSI_FENCE');
  });

  it('prefixes every rendered blockquote line', () => {
    _resetAnsiMarkdownForTests();
    const out = renderAnsiMarkdown('> first\n> second\n>\n> third');
    const plain = stripAnsi(out);
    expect(plain).toContain('│ first\n│ second');
    expect(plain).toContain('│ third');
  });

  it('renders nested blockquote prefixes once per depth', () => {
    _resetAnsiMarkdownForTests();
    const out = renderAnsiMarkdown('> outer\n> > inner');
    const plain = stripAnsi(out);
    expect(plain).toContain('│ outer');
    expect(plain).toContain('│ │ inner');
    expect(plain).not.toContain('│ │ │ inner');
  });

  it('keeps the blockquote gutter on tight lists inside the quote', () => {
    _resetAnsiMarkdownForTests();
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
    _resetAnsiMarkdownForTests();
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
    _resetAnsiMarkdownForTests();
    const out = renderAnsiMarkdown('1) one\n2) two');
    expect(stripAnsi(out)).toContain('1) one');
    expect(stripAnsi(out)).toContain('2) two');
  });

  it('renders headings without visible Markdown markers', () => {
    _resetAnsiMarkdownForTests();
    const out = renderAnsiMarkdown(
      '## What is a Tensor Network?\n\n### Core objects',
    );
    const plain = stripAnsi(out);
    expect(plain).toContain('What is a Tensor Network?');
    expect(plain).toContain('Core objects');
    expect(plain).not.toContain('## What');
    expect(plain).not.toContain('### Core');
  });

  it('separates consecutive paragraphs visually', () => {
    _resetAnsiMarkdownForTests();
    const out = renderAnsiMarkdown('First paragraph.\n\nSecond paragraph.');
    expect(stripAnsi(out)).toContain('First paragraph.\n\nSecond paragraph.');
  });

  it('wraps rendered markdown at display-cell boundaries', () => {
    _resetAnsiMarkdownForTests();
    const out = renderAnsiMarkdown('你好🙂abcdef', { width: 6 });
    const lines = stripAnsi(out).split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(displayWidthForTest(line)).toBeLessThanOrEqual(6);
    }
  });

  it('keeps blockquote gutters on wrapped continuation lines', () => {
    _resetAnsiMarkdownForTests();
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
    _resetAnsiMarkdownForTests();
    const out = renderAnsiMarkdown('- abcdef ghijkl mnopqr', { width: 10 });
    const plain = stripAnsi(out);
    const lines = plain.split('\n');
    expect(lines[0]).toMatch(/^ {2}• /);
    expect(lines.slice(1).every((line) => line.startsWith('    '))).toBe(true);
    for (const line of lines) {
      expect(displayWidthForTest(line)).toBeLessThanOrEqual(10);
    }
  });

  it('styles heading text across inline code boundaries', () => {
    _resetAnsiMarkdownForTests();
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

  it('memoises identical inputs (second call hits the cache)', () => {
    _resetAnsiMarkdownForTests();
    const first = renderAnsiMarkdown('# Title\n\nParagraph.');
    const before = _ansiMarkdownStatsForTests();
    const second = renderAnsiMarkdown('# Title\n\nParagraph.');
    const after = _ansiMarkdownStatsForTests();
    expect(second).toBe(first);
    // The second call must hit the cache, not re-render through markdown-it.
    expect(after.hits - before.hits).toBe(1);
    expect(after.misses - before.misses).toBe(0);
  });
});
