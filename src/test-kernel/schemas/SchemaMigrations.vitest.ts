import { describe, expect, it } from 'vitest';

import { RunUsageAccumulatorJSONSchema } from '@agent/core/usage/RunUsageAccumulator';
import {
  ActiveChildInfoSchema,
  ContextManagementDataSchema,
  OutputXmlSummarySchema,
  STREAM_PHASE,
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

describe('RunUsageAccumulatorJSONSchema — canonical shape', () => {
  it('parses empty object to zero totals and null latestUsage', () => {
    const result = RunUsageAccumulatorJSONSchema.parse({});

    expect(result.latestUsage).toBeNull();
    expect(result.totals.totalInputTokens).toBe(0);
  });

  it('passes a canonical payload through unchanged', () => {
    const result = RunUsageAccumulatorJSONSchema.parse({
      totals: { totalInputTokens: 100 },
      latestUsage: usageFixture,
    });

    expect(result.totals.totalInputTokens).toBe(100);
    expect(result.latestUsage).toMatchObject(usageFixture);
  });

  it('rejects a retired normalizedSnapshots blob instead of migrating it', () => {
    // The legacy writer is extinct; a blob still carrying the key must fail
    // loudly through the resume-parse failure path, not degrade silently.
    expect(() =>
      RunUsageAccumulatorJSONSchema.parse({
        normalizedSnapshots: [{ round: 0, usage: usageFixture }],
      }),
    ).toThrow();
  });
});

describe('OutputXmlSummarySchema — tagContents values', () => {
  it('passes a string[] value through unchanged', () => {
    const result = OutputXmlSummarySchema.parse({
      tagContents: { authors: ['Alice', 'Bob'] },
    });

    expect(result.tagContents['authors']).toEqual(['Alice', 'Bob']);
  });

  it('defaults a missing tagContents to an empty record', () => {
    const result = OutputXmlSummarySchema.parse({});

    expect(result.tagContents).toEqual({});
  });

  it.each([
    ['a retired bare-string value', { tagContents: { title: 'My Paper' } }],
    ['a malformed value', { tagContents: { broken: 42 } }],
  ])('rejects %s instead of coercing it', (_label, payload) => {
    // The string-to-array coercion and its .catch([]) are retired: persisted
    // data that no longer parses must fail loudly, not degrade silently.
    expect(() => OutputXmlSummarySchema.parse(payload)).toThrow();
  });
});

describe('OutputXmlSummarySchema — strict shape', () => {
  it.each([
    [
      'an unrecognized key on a record without documents',
      { tagContents: {}, unexpected: 1 },
    ],
    ['the retired documents key', { tagContents: {}, documents: [] }],
  ])('rejects %s', (_label, payload) => {
    expect(() => OutputXmlSummarySchema.parse(payload)).toThrow();
  });
});

describe('ContextManagementDataSchema', () => {
  const base = {
    tokensBefore: 1000,
    contextWindow: 200_000,
    utilizationBefore: 5,
  };

  it('passes an already-populated tokens-freed entry through unchanged', () => {
    const result = ContextManagementDataSchema.parse({
      ...base,
      action: 'compaction',
      tokensAfter: 400,
      utilizationAfter: 2,
    });

    expect(result).toMatchObject({ tokensAfter: 400, utilizationAfter: 2 });
  });

  it('still requires originalMaxTokens/reducedMaxTokens for max_tokens_reduced', () => {
    expect(() =>
      ContextManagementDataSchema.parse({
        ...base,
        action: 'max_tokens_reduced',
      }),
    ).toThrow();
  });

  it('rejects retired entries missing their completion statistics', () => {
    expect(() =>
      ContextManagementDataSchema.parse({ ...base, action: 'clear_tool_uses' }),
    ).toThrow();
  });
});

describe('ActiveChildInfoSchema — flat roster row', () => {
  const base = {
    executionId: 'exec-1',
    childStreamId: 'stream-1',
    agentName: 'review',
    identity: { kind: 'agent', agent: 'review' },
  };

  it('accepts a row carrying its parsed identity verbatim', () => {
    const result = ActiveChildInfoSchema.parse({
      ...base,
      identity: { kind: 'process', tool: 'bash' },
    });
    expect(result).toMatchObject({
      identity: { kind: 'process', tool: 'bash' },
    });
  });

  it('requires childStreamId — every child owns a stream tab', () => {
    expect(() =>
      ActiveChildInfoSchema.parse({
        executionId: 'exec-1',
        agentName: 'review',
      }),
    ).toThrow();
  });

  // `status` has no legacy migration on purpose. The child roster is liveness
  // state: `assembleSnapshot` never writes `subagents`, and every hydrate
  // clamps it to `[]`, so no on-disk roster carries the retired 7-value
  // `StreamStatus` vocabulary. The v0.41 cut dropped the speculative union
  // member that mapped it; the field now takes `StreamPhase` only.
  it('accepts a StreamPhase status', () => {
    const result = ActiveChildInfoSchema.parse({
      ...base,
      status: STREAM_PHASE.RUNNING,
    });

    expect(result).toMatchObject({ status: STREAM_PHASE.RUNNING });
  });

  it('rejects a retired StreamStatus value rather than folding it', () => {
    expect(() =>
      ActiveChildInfoSchema.parse({
        ...base,
        status: STREAM_STATUS.INITIALIZING,
      }),
    ).toThrow();
  });
});
