import { describe, expect, it } from 'vitest';

import {
  buildRelayUsageRowsUrl,
  currentUtcMonthRange,
  parseRelayUsageRows,
  parseUtcMonth,
  summarizeRelayUsage,
  type RelayUsageRow,
} from '@cli/runtime/relayUsage';

function row(input: Partial<RelayUsageRow>): RelayUsageRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
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

/** Raw (pre-parse) wire row for parseRelayUsageRows cases. */
function rawRow(overrides: Record<string, unknown>): Record<string, unknown>[] {
  return [
    {
      id: '00000000-0000-4000-8000-000000000002',
      logged_at: '2026-05-17T12:00:00+00:00',
      model: 'gpt-5.4',
      provider: 'openai',
      input_tokens: 10,
      output_tokens: 4,
      cached_input_tokens: null,
      reasoning_tokens: null,
      cost: '1.25',
      ...overrides,
    },
  ];
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

  // The command handler pre-validates `--month` so a malformed value yields
  // a Usage error (exit 2), not the catch-all ModelOrNetworkError (exit 3).
  // This contract is what makes that pre-validation possible.
  it.each(['not-a-date', '2026/05', '26-05', '2026-5', '2026-00', '2026-13'])(
    'rejects invalid month value %s',
    (value) => {
      expect(() => parseUtcMonth(value)).toThrow(/YYYY-MM format/);
    },
  );
});

describe('CLI relay usage summary', () => {
  it('accepts Supabase timestamptz offsets in usage rows', () => {
    const rows = parseRelayUsageRows(rawRow({}));

    expect(rows[0]?.logged_at).toBe('2026-05-17T12:00:00+00:00');
    expect(rows[0]?.cost).toBe(1.25);
  });

  it('rejects rows with a malformed cost instead of zero-defaulting spend', () => {
    // Regression test for #7468: billing fields must never silently parse to
    // 0 on a malformed value, since that would under-report spend against
    // the relay cap.
    expect(() =>
      parseRelayUsageRows(
        rawRow({
          id: '00000000-0000-4000-8000-000000000003',
          cost: 'not-a-number',
        }),
      ),
    ).toThrow();
  });

  it('rejects a null cost instead of coercing it to zero', () => {
    // `z.coerce.number()` alone would turn `null` into `0` via `Number(null)`
    // — the same silent-zero bug the `.catch(0)` removal fixes, reintroduced
    // through coercion. `cost` must reject null/undefined before coercing.
    expect(() =>
      parseRelayUsageRows(
        rawRow({ id: '00000000-0000-4000-8000-000000000005', cost: null }),
      ),
    ).toThrow();
  });

  it('rejects rows with a malformed token count instead of zero-defaulting usage', () => {
    expect(() =>
      parseRelayUsageRows(
        rawRow({
          id: '00000000-0000-4000-8000-000000000004',
          input_tokens: 'not-a-number',
        }),
      ),
    ).toThrow();
  });

  it('builds stable keyset pagination URLs', () => {
    const first = buildRelayUsageRowsUrl({
      startIso: '2026-05-01T00:00:00.000Z',
      endIso: '2026-06-01T00:00:00.000Z',
    });
    expect(first.searchParams.get('order')).toBe('logged_at.desc,id.desc');
    expect(first.searchParams.get('offset')).toBeNull();
    expect(first.searchParams.get('or')).toBeNull();

    const next = buildRelayUsageRowsUrl({
      startIso: '2026-05-01T00:00:00.000Z',
      endIso: '2026-06-01T00:00:00.000Z',
      cursor: {
        loggedAt: '2026-05-17T12:00:00+00:00',
        id: '00000000-0000-4000-8000-000000000002',
      },
    });
    expect(next.searchParams.get('or')).toBe(
      '(logged_at.lt.2026-05-17T12:00:00+00:00,and(logged_at.eq.2026-05-17T12:00:00+00:00,id.lt.00000000-0000-4000-8000-000000000002))',
    );
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
      streamCount: 2,
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
