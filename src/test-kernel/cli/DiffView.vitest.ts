import { describe, expect, it } from 'vitest';

import {
  diffDisplayLines,
  initialDiffScrollOffset,
  scrollBoundedDiffDisplayLines,
  wrappedDiffDisplayLines,
} from '@cli/chat/tui/render/DiffView';
import { buildDiffHunks } from '@utils/text/unifiedDiff';

const SIX_LINE_HUNK_SOURCE = [
  'alpha',
  'beta',
  'gamma',
  'delta',
  'epsilon',
  'zeta',
];
const FOUR_LINE_HUNK_SOURCE = ['alpha', 'beta', 'gamma', 'delta'];

// Builds hunks where every other line was upper-cased, giving an even mix of
// context and changed rows for the display-budget tests below.
function alternatingHunks(
  lines: string[],
): ReturnType<typeof buildDiffHunks>['hunks'] {
  const revised = lines.map((line, index) =>
    index % 2 === 1 ? line.toUpperCase() : line,
  );
  return buildDiffHunks(lines.join('\n'), revised.join('\n')).hunks;
}

describe('CLI diff display', () => {
  it('keeps the overflow marker inside the total display budget', () => {
    const hunks = alternatingHunks(SIX_LINE_HUNK_SOURCE);

    const lines = scrollBoundedDiffDisplayLines(hunks, 4, 0, 80);

    expect(lines).toHaveLength(4);
    expect(lines.at(-1)).toMatchObject({
      kind: 'overflow',
      text: expect.stringContaining('more rows'),
    });
  });

  it('prioritizes changed rows in a cramped diff window', () => {
    const hunks = alternatingHunks(FOUR_LINE_HUNK_SOURCE);

    const lines = scrollBoundedDiffDisplayLines(hunks, 3, undefined, 80);

    expect(lines).toHaveLength(3);
    expect(lines[0]?.kind).toBe('removed');
    expect(lines[1]?.kind).toBe('added');
    expect(lines[2]).toMatchObject({
      kind: 'overflow',
      text: expect.stringContaining('more rows'),
    });
  });

  it('opens a scrollable diff at the edit when wrapped context would hide it', () => {
    const context = [
      `First context paragraph ${'alpha '.repeat(18)}`,
      `Second context paragraph ${'beta '.repeat(18)}`,
      `Third context paragraph ${'gamma '.repeat(18)}`,
    ];
    const { hunks } = buildDiffHunks(
      [...context, 'Old acknowledgment.'].join('\n'),
      [...context, 'Revised acknowledgment.'].join('\n'),
    );
    const width = 40;
    const maxDisplayLines = 7;

    const topLines = scrollBoundedDiffDisplayLines(
      hunks,
      maxDisplayLines,
      0,
      width,
    );
    expect(topLines.every((line) => line.kind !== 'added')).toBe(true);
    expect(topLines.every((line) => line.kind !== 'removed')).toBe(true);

    const initialOffset = initialDiffScrollOffset(
      hunks,
      width,
      maxDisplayLines,
    );
    const initialLines = scrollBoundedDiffDisplayLines(
      hunks,
      maxDisplayLines,
      initialOffset,
      width,
    );

    expect(initialOffset).toBeGreaterThan(0);
    expect(initialLines.some((line) => line.kind === 'removed')).toBe(true);
    expect(initialLines.some((line) => line.kind === 'added')).toBe(true);
  });

  it('does not skip a standalone deletion to a later hunk addition', () => {
    const { hunks } = buildDiffHunks(
      [
        'alpha',
        'beta',
        'gamma',
        'remove this observation',
        'delta',
        'epsilon',
        'zeta',
        'eta',
        'theta',
        'replace this observation',
        'iota',
        'kappa',
        'lambda',
      ].join('\n'),
      [
        'alpha',
        'beta',
        'gamma',
        'delta',
        'epsilon',
        'zeta',
        'eta',
        'theta',
        'revised observation',
        'iota',
        'kappa',
        'lambda',
      ].join('\n'),
    );
    const maxDisplayLines = 6;
    const initialLines = scrollBoundedDiffDisplayLines(
      hunks,
      maxDisplayLines,
      initialDiffScrollOffset(hunks, 80, maxDisplayLines),
      80,
    );

    expect(initialLines.some((line) => line.text.includes('remove this'))).toBe(
      true,
    );
    expect(
      initialLines.some((line) => line.text.includes('revised observation')),
    ).toBe(false);
  });

  it('wraps long changed lines instead of replacing the tail with an ellipsis', () => {
    const proposed =
      'Here $2n+1$ is the $(n+1)$-st odd number, i.e., the next odd number after $2n-1$.';
    const { hunks } = buildDiffHunks('old sentence', proposed);

    const lines = wrappedDiffDisplayLines(hunks, 36);
    const rendered = lines.map((line) => line.text).join('\n');

    expect(rendered).toContain('after $2n-1$.');
    expect(rendered).not.toContain('…');
    expect(lines.length).toBeGreaterThan(diffDisplayLines(hunks).length);
  });
});
