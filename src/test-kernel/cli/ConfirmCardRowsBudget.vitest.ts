import { describe, expect, it } from 'vitest';

import { confirmCardContentRowsBudget } from '@cli/chat/tui/modals/confirmCardRowsBudget';

// Shared parameters modeled on the bash-approval modal: a one-row title at
// 80 columns, spacious chrome of 7 rows, compact chrome of 5, and a compact
// content cap of 3. titleRows resolves to 1 for the short title below, so the
// budgets are exact integers.
const BASE = {
  columns: 80,
  title: 'Run command?',
  minContentWidth: 20,
  defaultRows: 12,
  compactMaxRows: 3,
  spaciousFixedRows: 7,
  compactFixedRows: 5,
} as const;

describe('confirmCardContentRowsBudget', () => {
  it('returns the default budget when availableRows is unconstrained', () => {
    expect(confirmCardContentRowsBudget({ ...BASE })).toBe(12);
    expect(
      confirmCardContentRowsBudget({ ...BASE, availableRows: undefined }),
    ).toBe(12);
  });

  it('grants the spacious budget when rows are plentiful', () => {
    // 30 - spaciousFixedRows(7) - titleRows(1) = 22
    expect(confirmCardContentRowsBudget({ ...BASE, availableRows: 30 })).toBe(
      22,
    );
  });

  it('switches from spacious to compact at the compactMaxRows cutoff', () => {
    // availableRows 12: spacious = 12 - 7 - 1 = 4 > compactMaxRows(3) → 4
    expect(confirmCardContentRowsBudget({ ...BASE, availableRows: 12 })).toBe(
      4,
    );
    // availableRows 11: spacious = 11 - 7 - 1 = 3, not > 3 → compact path
    //   clamp(11 - 5 - 1, 1, 3) = clamp(5, 1, 3) = 3
    expect(confirmCardContentRowsBudget({ ...BASE, availableRows: 11 })).toBe(
      3,
    );
  });

  it('clamps the compact budget to at least one row when space is tiny', () => {
    // availableRows 6: spacious = -2 → compact clamp(6 - 5 - 1, 1, 3) = 1
    expect(confirmCardContentRowsBudget({ ...BASE, availableRows: 6 })).toBe(1);
  });

  it('counts extraFixedRows against both layouts', () => {
    // spacious = 30 - 7 - (1 + 5) = 17
    expect(
      confirmCardContentRowsBudget({
        ...BASE,
        availableRows: 30,
        extraFixedRows: 5,
      }),
    ).toBe(17);
  });

  it('subtracts wrapped title rows from the budget', () => {
    const longTitle = 'word '.repeat(60).trim();
    const wrapped = confirmCardContentRowsBudget({
      ...BASE,
      availableRows: 30,
      title: longTitle,
    });
    const single = confirmCardContentRowsBudget({
      ...BASE,
      availableRows: 30,
    });
    // A title that wraps onto more rows leaves fewer rows for content.
    expect(wrapped).toBeLessThan(single);
  });
});
