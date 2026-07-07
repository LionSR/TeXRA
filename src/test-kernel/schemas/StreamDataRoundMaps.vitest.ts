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

  it('RoundKeySchema coerces and rejects negative/fractional string keys', () => {
    expect(RoundKeySchema.safeParse('0')).toMatchObject({
      success: true,
      data: 0,
    });
    expect(RoundKeySchema.safeParse('5')).toMatchObject({
      success: true,
      data: 5,
    });
    expect(RoundKeySchema.safeParse('-1').success).toBe(false);
    expect(RoundKeySchema.safeParse('1.5').success).toBe(false);
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

  it('RoundKeyStringSchema rejects non-numeric and legacy runId-shaped keys', () => {
    expect(RoundKeyStringSchema.safeParse('run-1').success).toBe(false);
    expect(RoundKeyStringSchema.safeParse('abc').success).toBe(false);
    expect(RoundKeyStringSchema.safeParse('-1').success).toBe(false);
    expect(RoundKeyStringSchema.safeParse('1.5').success).toBe(false);
  });

  it('roundIndexedRecord() rejects negative, fractional, and non-numeric keys', () => {
    const schema = roundIndexedRecord(StringItemSchema);

    expect(schema.safeParse({ '0': ['a'], '5': ['b'] }).success).toBe(true);
    expect(schema.safeParse({ '-1': ['a'] }).success).toBe(false);
    expect(schema.safeParse({ '1.5': ['a'] }).success).toBe(false);
    expect(schema.safeParse({ 'run-1': ['a'] }).success).toBe(false);
  });

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
    const { rounds, wasLegacy } = parsePersistedRoundIndexed(
      'missingOutputs',
      { '1': ['a.tex', 'b.tex'], '2': [] },
      StringItemSchema,
    );

    expect(wasLegacy).toBe(false);
    expect(rounds).toEqual({ 1: ['a.tex', 'b.tex'] });
    // Round 2 is empty and must be dropped, not stored as an empty array.
    expect(rounds).not.toHaveProperty('2');
  });

  it('falls back to an empty record on malformed top-level input', () => {
    const { rounds, wasLegacy } = parsePersistedRoundIndexed(
      'outputFiles',
      'not-a-record',
      StringItemSchema,
    );

    expect(rounds).toEqual({});
    expect(wasLegacy).toBe(false);
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

    expect(first.rounds).not.toBe(second.rounds);

    first.rounds[1] = ['x'];
    expect(second.rounds).toEqual({});
  });

  it('treats a missing file (undefined) as empty, not legacy', () => {
    const { rounds, wasLegacy } = parsePersistedRoundIndexed(
      'outputFiles',
      undefined,
      StringItemSchema,
    );

    expect(rounds).toEqual({});
    expect(wasLegacy).toBe(false);
  });

  it('absorbs the legacy nested { runId: { round: items[] } } shape, picking the last-inserted run', () => {
    const { rounds, wasLegacy } = parsePersistedRoundIndexed(
      'missingOutputs',
      {
        'run-1': { '0': ['a.tex'] },
        'run-2': { '0': ['b.tex'], '1': ['c.tex'] },
      },
      StringItemSchema,
    );

    expect(wasLegacy).toBe(true);
    expect(rounds).toEqual({ 0: ['b.tex'], 1: ['c.tex'] });
  });

  it('prefers the preferredRunId when it exists in the legacy nested shape', () => {
    const { rounds, wasLegacy } = parsePersistedRoundIndexed(
      'missingOutputs',
      {
        'run-1': { '0': ['a.tex'] },
        'run-2': { '0': ['b.tex'] },
      },
      StringItemSchema,
      'run-1',
    );

    expect(wasLegacy).toBe(true);
    expect(rounds).toEqual({ 0: ['a.tex'] });
  });

  it('drops malformed items within an otherwise valid round, keeping the rest', () => {
    const { rounds } = parsePersistedRoundIndexed(
      'missingOutputs',
      { '1': ['a.tex', 42, 'b.tex'] },
      StringItemSchema,
    );

    expect(rounds).toEqual({ 1: ['a.tex', 'b.tex'] });
  });

  it('treats a record with any non-array round value as legacy-shaped and salvages nothing when it is not run-nested either', () => {
    // Mirrors the pre-refactor `isLegacyNested` predicate: a flat round
    // record must have EVERY value be an array, or the whole file is routed
    // to the legacy-run-nested arm instead of a per-round salvage. Here
    // neither arm finds anything usable, so the result is empty rather than
    // throwing.
    const { rounds, wasLegacy } = parsePersistedRoundIndexed(
      'missingOutputs',
      { '1': ['a.tex'], '2': 'not-an-array' },
      StringItemSchema,
    );

    expect(wasLegacy).toBe(true);
    expect(rounds).toEqual({});
  });

  it('treats a negative round key the same as any other non-integer key: legacy-shaped, salvaging nothing when not run-nested', () => {
    // A negative key fails RoundKeyStringSchema, so the flat arm rejects the
    // whole record (mirroring the non-integer-key case above) and the
    // legacy-nested arm finds no nested run object to salvage from.
    const { rounds, wasLegacy } = parsePersistedRoundIndexed(
      'missingOutputs',
      { '-1': ['a.tex'], '0': ['b.tex'] },
      StringItemSchema,
    );

    expect(wasLegacy).toBe(true);
    expect(rounds).toEqual({});
  });

  it('accepts a scientific-notation round key in the flat arm, agreeing with RoundKeySchema', () => {
    const { rounds, wasLegacy } = parsePersistedRoundIndexed(
      'missingOutputs',
      { '1e2': ['a.tex'] },
      StringItemSchema,
    );

    expect(wasLegacy).toBe(false);
    expect(rounds).toEqual({ 100: ['a.tex'] });
  });
});
