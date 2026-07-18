import { describe, expect, it } from 'vitest';

import { infoPaneRequiredRows } from '@cli/chat/tui/panes/InfoPane';

describe('CLI InfoPane layout', () => {
  it('includes title, border, and close-hint chrome in its row budget', () => {
    expect(infoPaneRequiredRows('Reference', ['one', '', 'three'], 40)).toBe(8);
  });

  it('falls back when long reference lines would wrap past the budget', () => {
    expect(infoPaneRequiredRows('Info', ['1234567890'], 4)).toBe(8);
  });

  it('includes wrapped title rows in the budget', () => {
    expect(infoPaneRequiredRows('/memory preview', ['one'], 8)).toBe(7);
  });
});
