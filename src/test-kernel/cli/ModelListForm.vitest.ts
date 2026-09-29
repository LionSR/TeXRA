import { describe, expect, it } from 'vitest';

import { selectVisibleInlineOverflowText } from '@cli/tui/overflowText';

describe('CLI Select inline overflow', () => {
  it.each<{
    name: string;
    args: Parameters<typeof selectVisibleInlineOverflowText>[0];
    expected: string | undefined;
  }>([
    {
      name: 'summarizes choices hidden after the window',
      args: {
        hiddenBefore: 0,
        hiddenAfter: 3,
        showOverflow: false,
        visibleItemCount: 3,
      },
      expected: '+3 more',
    },
    {
      name: 'summarizes choices hidden on both sides',
      args: {
        hiddenBefore: 2,
        hiddenAfter: 4,
        showOverflow: false,
        visibleItemCount: 3,
      },
      expected: '+2 earlier, +4 more',
    },
    {
      name: 'defers to separate overflow rows when they are enabled',
      args: {
        hiddenBefore: 0,
        hiddenAfter: 3,
        showOverflow: true,
        visibleItemCount: 3,
      },
      expected: undefined,
    },
    {
      name: 'suppresses inline overflow when there are no visible items',
      args: {
        hiddenBefore: 0,
        hiddenAfter: 3,
        showOverflow: false,
        visibleItemCount: 0,
      },
      expected: undefined,
    },
  ])('$name', ({ args, expected }) => {
    expect(selectVisibleInlineOverflowText(args)).toBe(expected);
  });
});
