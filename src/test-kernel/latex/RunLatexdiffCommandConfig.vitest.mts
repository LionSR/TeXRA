import { describe, expect, it } from 'vitest';

import { normalizeRunLatexdiffOutputsByRound } from '@latex/latexdiff/runLatexdiff';

import { createOutputFile } from '../support/ProgressControllerHarnesses';

describe('normalizeRunLatexdiffOutputsByRound', () => {
  it('keeps non-empty tuple-array rounds in numeric order', () => {
    const first = createOutputFile({ round: 1 });
    const second = createOutputFile({ round: 2 });

    expect(
      normalizeRunLatexdiffOutputsByRound([
        [2, [second]],
        [1, [first]],
        [3, []],
      ]),
    ).toEqual(
      new Map([
        [1, [first]],
        [2, [second]],
      ]),
    );
  });

  it('falls back for malformed or legacy map-shaped command payloads', () => {
    expect(
      normalizeRunLatexdiffOutputsByRound({ 1: [createOutputFile()] }),
    ).toBeNull();
    expect(normalizeRunLatexdiffOutputsByRound('not-rounds')).toBeNull();
  });

  it('drops non-integer round entries', () => {
    const valid = createOutputFile({ round: 1 });

    expect(
      normalizeRunLatexdiffOutputsByRound([
        [1.5, [createOutputFile({ round: 1.5 })]],
        [1, [valid]],
      ]),
    ).toEqual(new Map([[1, [valid]]]));
  });
});
