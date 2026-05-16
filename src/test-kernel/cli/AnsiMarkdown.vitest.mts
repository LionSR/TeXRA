// Smoke test for the CLI TUI's ANSI markdown renderer (Phase 3).
//
// We don't snapshot the exact ANSI bytes — that locks the layout in too hard.
// Instead, verify the renderer (a) preserves raw text, (b) doesn't HTML-escape
// inside fenced code, (c) routes through the shared factory + cache without
// crashing, and (d) hides the fence sentinel from the final output.

import { describe, expect, it } from 'vitest';
import stripAnsi from 'strip-ansi';

import {
  _ansiMarkdownStatsForTests,
  _resetAnsiMarkdownForTests,
  renderAnsiMarkdown,
} from '../../../packages/cli/src/chat/tui/render/ansiMarkdown';

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
    expect(stripAnsi(out)).toContain('│ first\n│ second\n│ third');
  });

  it('renders nested blockquote prefixes once per depth', () => {
    _resetAnsiMarkdownForTests();
    const out = renderAnsiMarkdown('> outer\n> > inner');
    expect(stripAnsi(out)).toContain('│ outer\n│ │ inner');
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

  it('preserves ordered-list delimiter markup', () => {
    _resetAnsiMarkdownForTests();
    const out = renderAnsiMarkdown('1) one\n2) two');
    expect(stripAnsi(out)).toContain('1) one');
    expect(stripAnsi(out)).toContain('2) two');
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
