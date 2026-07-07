import { describe, expect, it } from 'vitest';

import { toNewestFirstByTimestamp } from '@utils/core';

describe('toNewestFirstByTimestamp', () => {
  it('orders values by newest timestamp first', () => {
    const rows = [
      { id: 'middle', timestamp: '2026-06-20T12:00:00.000Z' },
      { id: 'newest', timestamp: '2026-06-21T12:00:00.000Z' },
      { id: 'oldest', timestamp: '2026-06-19T12:00:00.000Z' },
    ];

    expect(
      toNewestFirstByTimestamp(rows, (row) => row.timestamp).map(
        (row) => row.id,
      ),
    ).toEqual(['newest', 'middle', 'oldest']);
  });

  it('does not mutate the input array', () => {
    const rows = [
      { id: 'first', timestamp: '2026-06-20T12:00:00.000Z' },
      { id: 'second', timestamp: '2026-06-21T12:00:00.000Z' },
    ];

    const sorted = toNewestFirstByTimestamp(rows, (row) => row.timestamp);

    expect(sorted.map((row) => row.id)).toEqual(['second', 'first']);
    expect(rows.map((row) => row.id)).toEqual(['first', 'second']);
  });
});
