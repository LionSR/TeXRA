import { describe, expect, it } from 'vitest';

import {
  buildHunks,
  diffVisualRowCount,
  maxDiffScrollOffset,
  scrollBoundedDiffDisplayLines,
  wrappedDiffDisplayLines,
} from '@cli/chat/tui/render/DiffView';
import { fillRows } from '@cli/chat/tui/render/terminalText';

// Builds hunks where every other line was upper-cased, giving an even mix of
// context and changed rows for the display-budget tests below.
function alternatingHunks(lines: string[]): ReturnType<typeof buildHunks> {
  const revised = lines.map((line, index) =>
    index % 2 === 1 ? line.toUpperCase() : line,
  );
  return buildHunks('draft.tex', lines.join('\n'), revised.join('\n'));
}

describe('CLI diff display', () => {
  it('keeps the overflow marker inside the total display budget', () => {
    const hunks = alternatingHunks([
      'alpha',
      'beta',
      'gamma',
      'delta',
      'epsilon',
      'zeta',
    ]);

    const lines = scrollBoundedDiffDisplayLines(hunks, 30, 4, 0);

    expect(lines).toHaveLength(4);
    expect(lines.at(-1)).toMatchObject({
      kind: 'overflow',
      text: expect.stringContaining('more rows'),
    });
  });

  it('renders scroll markers around the visible diff window', () => {
    const hunks = alternatingHunks([
      'alpha',
      'beta',
      'gamma',
      'delta',
      'epsilon',
      'zeta',
    ]);

    const lines = scrollBoundedDiffDisplayLines(hunks, 0, 4, 2);

    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({
      kind: 'overflow',
      text: '... 2 previous rows',
    });
    expect(lines.at(-1)).toMatchObject({
      kind: 'overflow',
      text: expect.stringContaining('more rows'),
    });
  });

  it('clamps the bottom scroll offset so the last rows remain visible', () => {
    expect(maxDiffScrollOffset(10, 4)).toBe(7);
  });

  it('keeps cramped diff windows static', () => {
    expect(maxDiffScrollOffset(10, 1)).toBe(0);
    expect(maxDiffScrollOffset(10, 2)).toBe(0);
    expect(maxDiffScrollOffset(10, 3)).toBe(0);
  });

  it('shows a changed line in a one-row diff window', () => {
    const hunks = alternatingHunks(['alpha', 'beta', 'gamma', 'delta']);

    const lines = scrollBoundedDiffDisplayLines(hunks, 0, 1, 0);

    expect(lines).toHaveLength(1);
    expect(['added', 'removed']).toContain(lines[0]?.kind);
  });

  it('prioritizes changed rows in a cramped diff window', () => {
    const hunks = alternatingHunks(['alpha', 'beta', 'gamma', 'delta']);

    const lines = scrollBoundedDiffDisplayLines(hunks, 0, 3, 0);

    expect(lines).toHaveLength(3);
    expect(lines[0]?.kind).toBe('removed');
    expect(lines[1]?.kind).toBe('added');
    expect(lines[2]).toMatchObject({
      kind: 'overflow',
      text: expect.stringContaining('hidden'),
    });
  });

  it('wraps long changed lines instead of replacing the tail with an ellipsis', () => {
    const proposed =
      'Here $2n+1$ is the $(n+1)$-st odd number, i.e., the next odd number after $2n-1$.';
    const hunks = buildHunks('draft.tex', 'old sentence', proposed);

    const lines = wrappedDiffDisplayLines(hunks, 36);
    const rendered = lines.map((line) => line.text).join('\n');

    expect(rendered).toContain('after $2n-1$.');
    expect(rendered).not.toContain('…');
    expect(diffVisualRowCount(hunks, 36)).toBeGreaterThan(
      scrollBoundedDiffDisplayLines(hunks, 0, 0, 0).length,
    );
  });

  it('applies the display budget to wrapped visual diff rows', () => {
    const hunks = buildHunks(
      'draft.tex',
      'old sentence',
      'This is a deliberately long replacement sentence that needs multiple visual rows.',
    );

    const lines = scrollBoundedDiffDisplayLines(hunks, 0, 4, 0, 24);

    expect(lines).toHaveLength(4);
    expect(lines.at(-1)).toMatchObject({
      kind: 'overflow',
      text: expect.stringContaining('more rows'),
    });
    expect(lines.at(-1)?.text).not.toContain('diff rows');
  });

  it('keeps wrapped overflow markers to one visual row at narrow widths', () => {
    const hunks = buildHunks('draft.tex', 'old sentence', 'x'.repeat(220));

    const lines = scrollBoundedDiffDisplayLines(hunks, 0, 4, 0, 20);
    const marker = lines.at(-1);

    expect(lines).toHaveLength(4);
    expect(marker).toMatchObject({
      kind: 'overflow',
      text: expect.stringContaining('more rows'),
    });
    expect(marker?.text).not.toContain('diff rows');
    expect(marker?.text).not.toContain('\n');
    expect(marker?.text.length).toBeLessThanOrEqual(20);
  });
});

describe('full-width diff bands', () => {
  // `σ`/`∑` are single display columns; a naive `.length` pad would overshoot.
  it.each([
    {
      name: 'pads a short row out to the full width so the band fills the row',
      input: '+abc',
      width: 8,
      expected: '+abc    ',
    },
    {
      name: 'measures display columns, not code units, for wide glyphs',
      input: '+ σ ∑',
      width: 10,
      expected: '+ σ ∑     ',
    },
    {
      name: 'pads every visual row of a pre-wrapped multi-row line',
      input: '+aa\n+bb',
      width: 5,
      expected: '+aa  \n+bb  ',
    },
    {
      name: 'leaves a row that already meets or exceeds the width untouched',
      input: '+abcdef',
      width: 4,
      expected: '+abcdef',
    },
  ])('$name', ({ input, width, expected }) => {
    expect(fillRows(input, width)).toBe(expected);
  });
});
