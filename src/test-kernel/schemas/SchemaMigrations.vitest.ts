import { describe, expect, it } from 'vitest';

import { RunUsageAccumulatorJSONSchema } from '@agent/core/usage/RunUsageAccumulator';
import { OutputXmlSummarySchema } from '@shared/schemas';

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
