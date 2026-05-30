import { describe, expect, it } from 'vitest';

import {
  boundedDiffDisplayLines,
  buildHunks,
  DIFF_BAND_BG,
  fillRows,
  maxDiffScrollOffset,
  scrollBoundedDiffDisplayLines,
} from '@cli/chat/tui/render/DiffView';

describe('CLI diff display', () => {
  it('keeps the overflow marker inside the total display budget', () => {
    const hunks = buildHunks(
      'draft.tex',
      ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].join('\n'),
      ['alpha', 'BETA', 'gamma', 'DELTA', 'epsilon', 'ZETA'].join('\n'),
    );

    const lines = boundedDiffDisplayLines(hunks, 30, 4);

    expect(lines).toHaveLength(4);
    expect(lines.at(-1)).toMatchObject({
      kind: 'overflow',
      text: expect.stringContaining('more diff rows'),
    });
  });

  it('renders scroll markers around the visible diff window', () => {
    const hunks = buildHunks(
      'draft.tex',
      ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].join('\n'),
      ['alpha', 'BETA', 'gamma', 'DELTA', 'epsilon', 'ZETA'].join('\n'),
    );

    const lines = scrollBoundedDiffDisplayLines(hunks, 0, 4, 2);

    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({
      kind: 'overflow',
      text: '... 2 previous diff rows',
    });
    expect(lines.at(-1)).toMatchObject({
      kind: 'overflow',
      text: expect.stringContaining('more diff rows'),
    });
  });

  it('clamps the bottom scroll offset so the last rows remain visible', () => {
    expect(maxDiffScrollOffset(10, 4)).toBe(7);
  });

  it('keeps one- and two-row diff windows static', () => {
    expect(maxDiffScrollOffset(10, 1)).toBe(0);
    expect(maxDiffScrollOffset(10, 2)).toBe(0);
  });

  it('shows content plus an overflow marker in a two-row diff window', () => {
    const hunks = buildHunks(
      'draft.tex',
      ['alpha', 'beta', 'gamma', 'delta'].join('\n'),
      ['alpha', 'BETA', 'gamma', 'DELTA'].join('\n'),
    );

    const lines = scrollBoundedDiffDisplayLines(hunks, 0, 2, 1);

    expect(lines).toHaveLength(2);
    expect(lines[0]?.kind).not.toBe('overflow');
    expect(lines[1]).toMatchObject({
      kind: 'overflow',
      text: expect.stringContaining('more diff rows'),
    });
  });
});

describe('full-width diff bands', () => {
  it('only added/removed lines get a band background', () => {
    expect(DIFF_BAND_BG.added).toBeDefined();
    expect(DIFF_BAND_BG.removed).toBeDefined();
    expect(DIFF_BAND_BG.context).toBeUndefined();
    expect(DIFF_BAND_BG.header).toBeUndefined();
  });

  it('pads a short row out to the full width so the band fills the row', () => {
    expect(fillRows('+abc', 8)).toBe('+abc    ');
  });

  it('measures display columns, not code units, for wide glyphs', () => {
    // `σ`/`∑` are single display columns; a naive `.length` pad would overshoot.
    expect(fillRows('+ σ ∑', 10)).toBe('+ σ ∑     ');
  });

  it('pads every visual row of a pre-wrapped multi-row line', () => {
    expect(fillRows('+aa\n+bb', 5)).toBe('+aa  \n+bb  ');
  });

  it('leaves a row that already meets or exceeds the width untouched', () => {
    expect(fillRows('+abcdef', 4)).toBe('+abcdef');
  });
});
