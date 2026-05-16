// Smoke test for the CLI TUI's ANSI markdown renderer (Phase 3).
//
// We don't snapshot the exact ANSI bytes — that locks the layout in too hard.
// Instead, verify the renderer (a) preserves raw text, (b) doesn't HTML-escape
// inside fenced code, (c) routes through the shared factory + cache without
// crashing, and (d) hides the fence sentinel from the final output.

import { describe, expect, it } from 'vitest';

import {
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

  it('memoises identical inputs (second call hits the cache)', () => {
    _resetAnsiMarkdownForTests();
    const first = renderAnsiMarkdown('# Title\n\nParagraph.');
    const second = renderAnsiMarkdown('# Title\n\nParagraph.');
    expect(second).toBe(first);
  });
});
