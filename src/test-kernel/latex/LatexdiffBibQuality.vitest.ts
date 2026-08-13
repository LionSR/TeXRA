import { describe, expect, it } from 'vitest';

import {
  LATEXDIFF_CHANGES_ONLY_SUBTYPE,
  resolveLatexdiffSubtype,
} from '@latex/latexdiff/diffCommandExecutor';

describe('latexdiff bibliography quality helpers', () => {
  it('uses ONLYCHANGEDPAGE for changes-only diffs unless a caller supplies a subtype', () => {
    expect(resolveLatexdiffSubtype({ changesOnly: true })).toBe(
      LATEXDIFF_CHANGES_ONLY_SUBTYPE,
    );
    expect(
      resolveLatexdiffSubtype({
        changesOnly: true,
        subtype: 'SAFE',
      }),
    ).toBe('SAFE');
    expect(resolveLatexdiffSubtype({ changesOnly: false })).toBeUndefined();
  });
});
