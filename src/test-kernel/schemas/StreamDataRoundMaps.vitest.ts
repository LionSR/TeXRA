import { describe, expect, it } from 'vitest';

import { z } from 'zod';
import {
  parsePersistedRoundIndexed,
  roundIndexedRecord,
  RoundKeySchema,
  RoundKeyStringSchema,
  RoundNumberSchema,
} from '@shared/schemas';

const StringItemSchema = z.string();

describe('round-key/round-number invariant: non-negative safe integers only', () => {
  it('RoundNumberSchema rejects negative and fractional round numbers', () => {
    expect(RoundNumberSchema.safeParse(0).success).toBe(true);
    expect(RoundNumberSchema.safeParse(5).success).toBe(true);
    expect(RoundNumberSchema.safeParse(-1).success).toBe(false);
    expect(RoundNumberSchema.safeParse(1.5).success).toBe(false);
  });

  it.each([
    { key: '0', data: 0 },
    { key: '5', data: 5 },
  ])('RoundKeySchema coerces $key to $data', ({ key, data }) => {
    expect(RoundKeySchema.safeParse(key)).toMatchObject({
      success: true,
      data,
    });
  });

  it.each(['-1', '1.5'])('RoundKeySchema rejects %s', (key) => {
    expect(RoundKeySchema.safeParse(key).success).toBe(false);
  });

  it('RoundKeySchema and RoundKeyStringSchema agree on scientific notation', () => {
    // "1e5" is a plain numeric string Number() coerces to 100000; both the
    // scalar coercion and the record-key predicate must agree it is valid,
    // rather than one accepting it via numeric coercion and the other
    // rejecting it via a stricter digits-only regex.
    expect(RoundKeySchema.safeParse('1e5')).toMatchObject({
      success: true,
      data: 100000,
    });
    expect(RoundKeyStringSchema.safeParse('1e5').success).toBe(true);
  });

  it.each(['run-1', 'abc', '-1', '1.5'])(
    'RoundKeyStringSchema rejects non-numeric and legacy runId-shaped key %s',
    (key) => {
      expect(RoundKeyStringSchema.safeParse(key).success).toBe(false);
    },
  );

  it('roundIndexedRecord() accepts non-negative integer keys', () => {
    const schema = roundIndexedRecord(StringItemSchema);

    expect(schema.safeParse({ '0': ['a'], '5': ['b'] }).success).toBe(true);
  });

  it.each(['-1', '1.5', 'run-1'])(
    'roundIndexedRecord() rejects key %s',
    (key) => {
      const schema = roundIndexedRecord(StringItemSchema);

      expect(schema.safeParse({ [key]: ['a'] }).success).toBe(false);
    },
  );

  it('roundIndexedRecord() accepts scientific-notation keys, matching RoundKeySchema', () => {
    const schema = roundIndexedRecord(StringItemSchema);
    expect(schema.safeParse({ '1e5': ['a'] })).toMatchObject({
      success: true,
      data: { '1e5': ['a'] },
    });
  });
});

describe('parsePersistedRoundIndexed (canonical round-indexed parse entry)', () => {
  it('coerces string round keys and drops empty rounds', () => {
    const rounds = parsePersistedRoundIndexed(
      'missingOutputs',
      { '1': ['a.tex', 'b.tex'], '2': [] },
      StringItemSchema,
    );

    expect(rounds).toEqual({ 1: ['a.tex', 'b.tex'] });
    // Round 2 is empty and must be dropped, not stored as an empty array.
    expect(rounds).not.toHaveProperty('2');
  });

  it('falls back to an empty record on malformed top-level input', () => {
    const rounds = parsePersistedRoundIndexed(
      'outputFiles',
      'not-a-record',
      StringItemSchema,
    );

    expect(rounds).toEqual({});
  });

  it('returns a fresh record per failed parse so consumers cannot leak across streams', () => {
    // Both parses fail and hit the "malformed top-level" fallback. Each must
    // yield a distinct object, because consumers (StreamSnapshotStore) hold
    // the parsed record by reference and mutate it in place.
    const first = parsePersistedRoundIndexed(
      'compileFailures',
      42,
      StringItemSchema,
    );
    const second = parsePersistedRoundIndexed(
      'compileFailures',
      42,
      StringItemSchema,
    );

    expect(first).not.toBe(second);

    first[1] = ['x'];
    expect(second).toEqual({});
  });

  it('treats a missing file as empty', () => {
    const rounds = parsePersistedRoundIndexed(
      'outputFiles',
      undefined,
      StringItemSchema,
    );

    expect(rounds).toEqual({});
  });

  it('drops malformed items within an otherwise valid round, keeping the rest', () => {
    const rounds = parsePersistedRoundIndexed(
      'missingOutputs',
      { '1': ['a.tex', 42, 'b.tex'] },
      StringItemSchema,
    );

    expect(rounds).toEqual({ 1: ['a.tex', 'b.tex'] });
  });

  it('drops a non-array round while preserving valid siblings', () => {
    const rounds = parsePersistedRoundIndexed(
      'missingOutputs',
      { '1': ['a.tex'], '2': 'not-an-array' },
      StringItemSchema,
    );

    expect(rounds).toEqual({ 1: ['a.tex'] });
  });

  it('drops an invalid round key while preserving valid siblings', () => {
    const rounds = parsePersistedRoundIndexed(
      'missingOutputs',
      { '-1': ['a.tex'], '0': ['b.tex'] },
      StringItemSchema,
    );

    expect(rounds).toEqual({ 0: ['b.tex'] });
  });

  it('accepts a scientific-notation round key, agreeing with RoundKeySchema', () => {
    const rounds = parsePersistedRoundIndexed(
      'missingOutputs',
      { '1e2': ['a.tex'] },
      StringItemSchema,
    );

    expect(rounds).toEqual({ 100: ['a.tex'] });
  });
});
