import { describe, expect, it } from 'vitest';

import {
  boundedDiffDisplayLines,
  buildHunks,
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
});
