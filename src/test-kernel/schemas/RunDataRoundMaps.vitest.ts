import { describe, expect, it } from 'vitest';

import { z } from 'zod';
import { roundIndexedRecord, RoundNumberSchema } from '@shared/schemas';

const StringItemSchema = z.string();

describe('round-key/round-number invariant: non-negative safe integers only', () => {
  it('RoundNumberSchema rejects negative and fractional round numbers', () => {
    expect(RoundNumberSchema.safeParse(0).success).toBe(true);
    expect(RoundNumberSchema.safeParse(5).success).toBe(true);
    expect(RoundNumberSchema.safeParse(-1).success).toBe(false);
    expect(RoundNumberSchema.safeParse(1.5).success).toBe(false);
  });

  it('roundIndexedRecord() accepts non-negative integer keys', () => {
    const schema = roundIndexedRecord(StringItemSchema);

    expect(schema.safeParse({ '0': ['a'], '5': ['b'] }).success).toBe(true);
  });

  // '9007199254740993' is unsafe: Number() collapses it onto 2^53, so it
  // would overwrite round 9007199254740992 in cloneRoundIndexed/nonEmptyRounds.
  it.each(['-1', '1.5', 'run-1', '1e2', '01', '', '9007199254740993'])(
    'roundIndexedRecord() rejects key %s',
    (key) => {
      const schema = roundIndexedRecord(StringItemSchema);

      expect(schema.safeParse({ [key]: ['a'] }).success).toBe(false);
    },
  );
});
