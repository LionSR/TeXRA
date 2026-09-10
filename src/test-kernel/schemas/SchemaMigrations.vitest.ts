import { describe, expect, it } from 'vitest';

import { RunUsageAccumulatorJSONSchema } from '@agent/core/usage/RunUsageAccumulator';
import {
  ContextManagementDataSchema,
  RUN_PHASE,
  RunSnapshotSchema,
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

describe('RunSnapshotSchema.status — canonical phases only', () => {
  // The retired 7-value RunStatus vocabulary is no longer normalized at the
  // parse boundary: an archived trace.json export still carrying it fails
  // loudly rather than being collapsed into a RunPhase.
  it.each(['initializing', 'resuming', 'error', 'stopped', 'ready'])(
    'rejects the retired status "%s"',
    (retired) => {
      expect(() =>
        RunSnapshotSchema.parse({
          runId: 'abc123def456',
          status: retired,
        }),
      ).toThrow();
    },
  );

  it('passes a canonical phase through unchanged', () => {
    const result = RunSnapshotSchema.parse({
      runId: 'abc123def457',
      status: RUN_PHASE.RUNNING,
    });

    expect(result.status).toBe(RUN_PHASE.RUNNING);
  });
});
