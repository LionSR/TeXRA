import { describe, expect, it } from 'vitest';

import {
  CompileFailuresDataSchema,
  MissingOutputsDataSchema,
  OutputFilesDataSchema,
} from '@shared/schemas';

describe('round-keyed stream data parsing', () => {
  it('coerces string round keys and drops empty rounds', () => {
    const missing = MissingOutputsDataSchema.parse({
      '1': ['a.tex', 'b.tex'],
      '2': [],
    });

    expect(missing).toBeInstanceOf(Map);
    expect(missing.get(1)).toEqual(['a.tex', 'b.tex']);
    // Round 2 is empty and must be dropped, not stored as an empty array.
    expect(missing.has(2)).toBe(false);
  });

  it('falls back to an empty map on malformed top-level input', () => {
    const result = OutputFilesDataSchema.parse('not-a-record');

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it('returns a fresh map per failed parse so consumers cannot leak across streams', () => {
    // Both parses fail and hit the `.catch(() => new Map())` fallback. Each
    // must yield a distinct instance, because consumers (StreamSnapshotStore)
    // hold the parsed map by reference and mutate it via `.set()`.
    const first = CompileFailuresDataSchema.parse(42);
    const second = CompileFailuresDataSchema.parse(42);

    expect(first).not.toBe(second);

    first.set(1, []);
    expect(second.size).toBe(0);
  });
});
