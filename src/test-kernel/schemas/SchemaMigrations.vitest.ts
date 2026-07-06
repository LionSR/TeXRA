import { describe, expect, it } from 'vitest';

import { RunUsageAccumulatorJSONSchema } from '@agent/core/usage/RunUsageAccumulator';
import {
  ContextManagementDataSchema,
  OutputXmlSummarySchema,
} from '@shared/schemas';

// Minimal NormalizedUsage fixture: all required fields, no optionals.
const usageFixture = {
  inputTokens: 100,
  outputTokens: 20,
  cost: 0.01,
  responseTimeMs: 500,
  provider: 'anthropic',
} as const;

describe('RunUsageAccumulatorJSONSchema — legacy normalizedSnapshots migration', () => {
  it('extracts latestUsage from a single-element normalizedSnapshots array', () => {
    const result = RunUsageAccumulatorJSONSchema.parse({
      normalizedSnapshots: [{ round: 0, usage: usageFixture }],
    });

    expect(result.latestUsage).toMatchObject(usageFixture);
  });

  it('takes the last element when normalizedSnapshots has multiple entries', () => {
    const older = { ...usageFixture, inputTokens: 50 };
    const latest = { ...usageFixture, inputTokens: 200 };
    const result = RunUsageAccumulatorJSONSchema.parse({
      normalizedSnapshots: [
        { round: 0, usage: older },
        { round: 1, usage: latest },
      ],
    });

    expect(result.latestUsage?.inputTokens).toBe(200);
  });

  it('sets latestUsage to null for an empty normalizedSnapshots array', () => {
    const result = RunUsageAccumulatorJSONSchema.parse({
      normalizedSnapshots: [],
    });

    expect(result.latestUsage).toBeNull();
  });

  it('is idempotent: already-migrated data passes through unchanged', () => {
    const result = RunUsageAccumulatorJSONSchema.parse({
      latestUsage: usageFixture,
    });

    expect(result.latestUsage).toMatchObject(usageFixture);
  });

  it('keeps canonical latestUsage when a hybrid payload also has snapshots', () => {
    const stale = { ...usageFixture, inputTokens: 1 };
    const result = RunUsageAccumulatorJSONSchema.parse({
      latestUsage: usageFixture,
      normalizedSnapshots: [{ round: 0, usage: stale }],
    });

    // The canonical latestUsage must win over the snapshot-derived value.
    expect(result.latestUsage).toMatchObject(usageFixture);
  });

  it('keeps an explicit null latestUsage over snapshots in a hybrid payload', () => {
    const result = RunUsageAccumulatorJSONSchema.parse({
      latestUsage: null,
      normalizedSnapshots: [{ round: 0, usage: usageFixture }],
    });

    // Key-presence semantics: an explicit null means already-migrated, so the
    // snapshot must NOT revive a value. Matches the old `'latestUsage' in raw`.
    expect(result.latestUsage).toBeNull();
  });

  it('preserves the last valid usage when an earlier snapshot is malformed', () => {
    const result = RunUsageAccumulatorJSONSchema.parse({
      normalizedSnapshots: [
        { round: 0, usage: { bogus: 'not a usage' } },
        { round: 1, usage: usageFixture },
      ],
    });

    // A malformed earlier snapshot must not drop the latest valid usage.
    expect(result.latestUsage).toMatchObject(usageFixture);
  });

  it('parses empty object to zero totals and null latestUsage', () => {
    const result = RunUsageAccumulatorJSONSchema.parse({});

    expect(result.latestUsage).toBeNull();
    expect(result.totals.totalInputTokens).toBe(0);
  });
});

describe('OutputXmlSummarySchema — tagContents legacy string coercion', () => {
  it('coerces a bare string value to a single-element array', () => {
    const result = OutputXmlSummarySchema.parse({
      tagContents: { title: 'My Paper' },
    });

    expect(result.tagContents['title']).toEqual(['My Paper']);
  });

  it('passes an existing string[] through unchanged', () => {
    const result = OutputXmlSummarySchema.parse({
      tagContents: { authors: ['Alice', 'Bob'] },
    });

    expect(result.tagContents['authors']).toEqual(['Alice', 'Bob']);
  });

  it('degrades a malformed value to [] via .catch', () => {
    const result = OutputXmlSummarySchema.parse({
      tagContents: { broken: 42 },
    });

    expect(result.tagContents['broken']).toEqual([]);
  });
});

describe('ContextManagementDataSchema — legacy missing tokensAfter/utilizationAfter', () => {
  const legacyBase = {
    tokensBefore: 1000,
    contextWindow: 200_000,
    utilizationBefore: 5,
  };

  it('defaults tokensAfter/utilizationAfter from the before-values on a pre-union entry', () => {
    const result = ContextManagementDataSchema.parse({
      ...legacyBase,
      action: 'clear_tool_uses',
    });

    expect(result).toMatchObject({
      action: 'clear_tool_uses',
      tokensAfter: 1000,
      utilizationAfter: 5,
    });
  });

  it('passes an already-populated tokens-freed entry through unchanged', () => {
    const result = ContextManagementDataSchema.parse({
      ...legacyBase,
      action: 'compaction',
      tokensAfter: 400,
      utilizationAfter: 2,
    });

    expect(result).toMatchObject({ tokensAfter: 400, utilizationAfter: 2 });
  });

  it('still requires originalMaxTokens/reducedMaxTokens for max_tokens_reduced', () => {
    expect(() =>
      ContextManagementDataSchema.parse({
        ...legacyBase,
        action: 'max_tokens_reduced',
      }),
    ).toThrow();
  });
});
