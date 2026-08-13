import { describe, expect, it } from 'vitest';

import { infoPaneRequiredRows } from '@cli/chat/tui/panes/InfoPane';

describe('CLI InfoPane layout', () => {
  it.each([
    {
      name: 'includes title, border, and close-hint chrome in its row budget',
      title: 'Reference',
      lines: ['one', '', 'three'],
      width: 40,
      expected: 8,
    },
    {
      name: 'falls back when long reference lines would wrap past the budget',
      title: 'Info',
      lines: ['1234567890'],
      width: 4,
      expected: 8,
    },
    {
      name: 'includes wrapped title rows in the budget',
      title: '/memory preview',
      lines: ['one'],
      width: 8,
      expected: 7,
    },
  ])('$name', ({ title, lines, width, expected }) => {
    expect(infoPaneRequiredRows(title, lines, width)).toBe(expected);
  });
});
