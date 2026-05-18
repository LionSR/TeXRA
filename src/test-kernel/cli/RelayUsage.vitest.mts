import { describe, expect, it } from 'vitest';

import {
  currentUtcMonthRange,
  parseRelayUsageRows,
  parseUtcMonth,
  summarizeRelayUsage,
  type RelayUsageRow,
} from '../../../packages/cli/src/runtime/relayUsage';

function row(input: Partial<RelayUsageRow>): RelayUsageRow {
  return {
    logged_at: '2026-05-17T12:00:00.000Z',
    model: 'gpt-5.4',
    provider: 'openai',
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    reasoning_tokens: 0,
    cost: 0,
    ...input,
  };
}

describe('CLI relay usage ranges', () => {
  it('builds UTC month ranges for explicit months', () => {
    const range = parseUtcMonth('2026-05');
    expect(range.start.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('builds the current UTC month range', () => {
    const range = currentUtcMonthRange(new Date('2026-12-31T23:30:00.000Z'));
    expect(range.start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(range.end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('CLI relay usage summary', () => {
  it('accepts Supabase timestamptz offsets in usage rows', () => {
    const rows = parseRelayUsageRows([
      {
        logged_at: '2026-05-17T12:00:00+00:00',
        model: 'gpt-5.4',
        provider: 'openai',
        input_tokens: 10,
        output_tokens: 4,
        cached_input_tokens: null,
        reasoning_tokens: null,
        cost: '1.25',
      },
    ]);

    expect(rows[0]?.logged_at).toBe('2026-05-17T12:00:00+00:00');
    expect(rows[0]?.cost).toBe(1.25);
  });

  it('aggregates spend, tokens, and distinct surfaces', () => {
    const summary = summarizeRelayUsage(
      [
        row({
          input_tokens: 10,
          cached_input_tokens: 5,
          output_tokens: 3,
          reasoning_tokens: 2,
          cost: 1.25,
        }),
        row({
          model: 'claude-sonnet-4-5',
          provider: 'anthropic',
          input_tokens: 7,
          output_tokens: 4,
          cost: 0.75,
        }),
      ],
      {
        tier: 'Max',
        periodStart: '2026-05-01T00:00:00.000Z',
        periodEnd: '2026-06-01T00:00:00.000Z',
      },
    );

    expect(summary).toMatchObject({
      limitUsd: 50,
      costUsd: 2,
      remainingUsd: 48,
      usagePercent: 4,
      requestCount: 2,
      inputTokens: 22,
      netInputTokens: 17,
      outputTokens: 7,
      cachedTokens: 5,
      reasoningTokens: 2,
      modelsUsed: 2,
      providersUsed: 2,
    });
  });
});
