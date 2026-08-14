import { z } from 'zod';

import { SupabaseClient } from '@auth/SupabaseClient';
import { SUPABASE_CONFIG, getRelaySpendingLimit } from '@auth/config';
import { utcMonthStart } from '@utils/core';

const USAGE_PAGE_SIZE = 1000;

// Billing fields intentionally have no `.catch()` fallback: a malformed
// input_tokens/output_tokens/cached_input_tokens/reasoning_tokens/cost value
// must fail parsing loudly rather than silently summing as 0, which would
// under-report spend against the relay cap (see #7468, and the May-2026
// abuse incident that motivated the cap). `cost` is restricted to
// number|string before coercion — bare `z.coerce.number()` would otherwise
// coerce `null`/`undefined`/booleans to `0` via `Number()`, reintroducing the
// same silent-zero bug through coercion instead of `.catch()`.
const RelayUsageRowSchema = z.object({
  id: z.uuid(),
  logged_at: z.iso.datetime({ offset: true }),
  model: z.string(),
  provider: z.string(),
  input_tokens: z.int().nonnegative(),
  output_tokens: z.int().nonnegative(),
  cached_input_tokens: z.int().nonnegative().nullable(),
  reasoning_tokens: z.int().nonnegative().nullable(),
  cost: z
    .union([z.number(), z.string()])
    .transform(Number)
    .pipe(z.number().nonnegative()),
});

export type RelayUsageRow = z.infer<typeof RelayUsageRowSchema>;

export function parseRelayUsageRows(data: unknown): RelayUsageRow[] {
  return z.array(RelayUsageRowSchema).parse(data);
}

export interface RelayUsageSummary {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly tier: string;
  readonly limitUsd: number;
  readonly costUsd: number;
  readonly remainingUsd: number;
  readonly usagePercent: number;
  readonly streamCount: number;
  readonly inputTokens: number;
  readonly netInputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly reasoningTokens: number;
  readonly modelsUsed: number;
  readonly providersUsed: number;
}

export function currentUtcMonthRange(now = new Date()): {
  start: Date;
  end: Date;
} {
  const year = now.getUTCFullYear();
  const monthIndex = now.getUTCMonth();
  return {
    start: utcMonthStart(year, monthIndex),
    end: utcMonthStart(year, monthIndex + 1),
  };
}

export function parseUtcMonth(month: string): { start: Date; end: Date } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error('Expected month in YYYY-MM format.');

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  // `year` is always an integer: the regex only admits four digits.
  if (monthIndex < 0 || monthIndex > 11) {
    throw new Error('Expected month in YYYY-MM format.');
  }

  return {
    start: utcMonthStart(year, monthIndex),
    end: utcMonthStart(year, monthIndex + 1),
  };
}

export async function fetchRelayUsageSummary(input: {
  tier: string;
  month?: string;
}): Promise<RelayUsageSummary> {
  const { start, end } = input.month
    ? parseUtcMonth(input.month)
    : currentUtcMonthRange();
  const token = await SupabaseClient.getAccessToken();
  if (!token) {
    throw new Error('Not signed in. Run `texra login` first.');
  }

  const rows = await fetchRelayUsageRows({
    token,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  });

  return summarizeRelayUsage(rows, {
    tier: input.tier,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
  });
}

export function summarizeRelayUsage(
  rows: readonly RelayUsageRow[],
  input: { tier: string; periodStart: string; periodEnd: string },
): RelayUsageSummary {
  const limitUsd = getRelaySpendingLimit(input.tier);
  const totals = rows.reduce(
    (acc, row) => {
      const cachedTokens = row.cached_input_tokens ?? 0;
      acc.costUsd += row.cost;
      acc.netInputTokens += row.input_tokens;
      acc.inputTokens += row.input_tokens + cachedTokens;
      acc.outputTokens += row.output_tokens;
      acc.cachedTokens += cachedTokens;
      acc.reasoningTokens += row.reasoning_tokens ?? 0;
      acc.models.add(row.model);
      acc.providers.add(row.provider);
      return acc;
    },
    {
      costUsd: 0,
      inputTokens: 0,
      netInputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      models: new Set<string>(),
      providers: new Set<string>(),
    },
  );

  const costUsd = roundCurrency(totals.costUsd);
  return {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    tier: input.tier,
    limitUsd,
    costUsd,
    remainingUsd: roundCurrency(Math.max(0, limitUsd - costUsd)),
    usagePercent:
      limitUsd > 0 ? Number(((costUsd / limitUsd) * 100).toFixed(1)) : 0,
    streamCount: rows.length,
    inputTokens: totals.inputTokens,
    netInputTokens: totals.netInputTokens,
    outputTokens: totals.outputTokens,
    cachedTokens: totals.cachedTokens,
    reasoningTokens: totals.reasoningTokens,
    modelsUsed: totals.models.size,
    providersUsed: totals.providers.size,
  };
}

async function fetchRelayUsageRows(input: {
  token: string;
  startIso: string;
  endIso: string;
}): Promise<RelayUsageRow[]> {
  const rows: RelayUsageRow[] = [];
  let cursor: RelayUsageCursor | undefined;
  for (;;) {
    const url = buildRelayUsageRowsUrl({ ...input, cursor });

    const response = await fetch(url, {
      headers: {
        apikey: SUPABASE_CONFIG.publicKey,
        Authorization: `Bearer ${input.token}`,
      },
    });
    if (!response.ok) {
      throw new Error(
        `Could not read your usage right now, try again in a moment (HTTP ${response.status}).`,
      );
    }

    const data = parseRelayUsageRows(await response.json());
    rows.push(...data);
    if (data.length < USAGE_PAGE_SIZE) return rows;
    const last = data.at(-1)!;
    cursor = { loggedAt: last.logged_at, id: last.id };
  }
}

export interface RelayUsageCursor {
  readonly loggedAt: string;
  readonly id: string;
}

export function buildRelayUsageRowsUrl(input: {
  startIso: string;
  endIso: string;
  cursor?: RelayUsageCursor;
}): URL {
  const url = new URL('/rest/v1/usage_logs', SUPABASE_CONFIG.url);
  url.searchParams.set(
    'select',
    [
      'id',
      'logged_at',
      'model',
      'provider',
      'input_tokens',
      'output_tokens',
      'cached_input_tokens',
      'reasoning_tokens',
      'cost',
    ].join(','),
  );
  url.searchParams.set('used_relay', 'eq.true');
  url.searchParams.append('logged_at', `gte.${input.startIso}`);
  url.searchParams.append('logged_at', `lt.${input.endIso}`);
  if (input.cursor) {
    const cursorPredicates = [
      `logged_at.lt.${input.cursor.loggedAt}`,
      `and(logged_at.eq.${input.cursor.loggedAt},id.lt.${input.cursor.id})`,
    ].join(',');
    url.searchParams.set('or', `(${cursorPredicates})`);
  }
  url.searchParams.set('order', 'logged_at.desc,id.desc');
  url.searchParams.set('limit', String(USAGE_PAGE_SIZE));
  return url;
}

function roundCurrency(value: number): number {
  return Number(value.toFixed(6));
}
