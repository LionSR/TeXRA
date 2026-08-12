import { describe, expect, it, vi } from 'vitest';

import { RunUsageAccumulatorJSONSchema } from '@agent/core/usage/RunUsageAccumulator';
import * as logger from '@logger/logUtils';
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
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const result = RunUsageAccumulatorJSONSchema.parse({
        normalizedSnapshots: [
          { round: 0, usage: { bogus: 'not a usage' } },
          { round: 1, usage: usageFixture },
        ],
      });

      // A malformed earlier snapshot must not drop the latest valid usage.
      expect(result.latestUsage).toMatchObject(usageFixture);
      // The degradation must be logged, not silent.
      expect(warnSpy).toHaveBeenCalledWith(
        'RunUsageAccumulator',
        expect.stringContaining('Malformed legacy normalizedSnapshots entry'),
        expect.anything(),
      );
    } finally {
      warnSpy.mockRestore();
    }
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
