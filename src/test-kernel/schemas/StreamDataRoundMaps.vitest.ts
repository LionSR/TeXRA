import { describe, expect, it } from 'vitest';

import { z } from 'zod';
import { parsePersistedRoundIndexed } from '@shared/schemas';

const StringItemSchema = z.string();

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
});
