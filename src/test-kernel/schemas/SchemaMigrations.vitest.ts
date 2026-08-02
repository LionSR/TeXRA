import { describe, expect, it } from 'vitest';

import { RunUsageAccumulatorJSONSchema } from '@agent/core/usage/RunUsageAccumulator';
import {
  ActiveChildInfoSchema,
  ContextManagementDataSchema,
  OutputXmlSummarySchema,
  STREAM_STATUS,
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

describe('OutputXmlSummarySchema — legacy documents field', () => {
  it('drops the documents copy a pre-removal record still carries', () => {
    const result = OutputXmlSummarySchema.parse({
      tagContents: { documents: ['Body A'] },
      documents: ['Body A'],
      singleOutputFile: '/tmp/run/main.tex',
      sourceLocation: null,
    });

    expect(result).toStrictEqual({
      tagContents: { documents: ['Body A'] },
      singleOutputFile: '/tmp/run/main.tex',
      sourceLocation: null,
    });
  });

  it('rejects an unrecognized key alongside legacy documents', () => {
    expect(() =>
      OutputXmlSummarySchema.parse({ documents: [], unexpected: 1 }),
    ).toThrow();
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

describe('ActiveChildInfoSchema — legacy missing kind discriminant', () => {
  const legacyBase = {
    executionId: 'exec-1',
    agentName: 'review',
  };

  it('infers kind: subagent from a legacy entry that has childStreamId', () => {
    const result = ActiveChildInfoSchema.parse({
      ...legacyBase,
      childStreamId: 'stream-1',
    });

    expect(result).toMatchObject({
      kind: 'subagent',
      childStreamId: 'stream-1',
    });
  });

  it('infers kind: process from a legacy entry without childStreamId', () => {
    const result = ActiveChildInfoSchema.parse({ ...legacyBase });

    expect(result).toMatchObject({ kind: 'process' });
  });

  // `status` has no legacy migration on purpose. The child roster is liveness
  // state: `assembleSnapshot` never writes `subagents`, and every hydrate
  // clamps it to `[]`, so no on-disk roster carries the retired 7-value
  // `StreamStatus` vocabulary. The v0.41 cut dropped the speculative union
  // member that mapped it; the field now takes `StreamPhase` only.
  it('rejects a retired StreamStatus value rather than folding it', () => {
    expect(() =>
      ActiveChildInfoSchema.parse({
        ...legacyBase,
        kind: 'process',
        status: STREAM_STATUS.INITIALIZING,
      }),
    ).toThrow();
  });
});
