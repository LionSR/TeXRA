import { z } from 'zod';

import { SupabaseClient } from '@auth/SupabaseClient';
import { SUPABASE_CONFIG, getRelaySpendingLimit } from '@auth/sharedConfig';

const USAGE_PAGE_SIZE = 1000;

const RelayUsageRowSchema = z.object({
  logged_at: z.iso.datetime({ offset: true }),
  model: z.string(),
  provider: z.string(),
  input_tokens: z.int().nonnegative().catch(0),
  output_tokens: z.int().nonnegative().catch(0),
  cached_input_tokens: z.int().nonnegative().nullable().catch(0),
  reasoning_tokens: z.int().nonnegative().nullable().catch(0),
  cost: z.coerce.number().nonnegative().catch(0),
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
  readonly requestCount: number;
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
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );
  return { start, end };
}

export function parseUtcMonth(month: string): { start: Date; end: Date } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error('Expected month in YYYY-MM format.');

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (!Number.isInteger(year) || monthIndex < 0 || monthIndex > 11) {
    throw new Error('Expected month in YYYY-MM format.');
  }

  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1));
  return { start, end };
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
    requestCount: rows.length,
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
  for (let offset = 0; ; offset += USAGE_PAGE_SIZE) {
    const url = new URL('/rest/v1/usage_logs', SUPABASE_CONFIG.url);
    url.searchParams.set(
      'select',
      [
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
    url.searchParams.set('order', 'logged_at.desc');
    url.searchParams.set('limit', String(USAGE_PAGE_SIZE));
    url.searchParams.set('offset', String(offset));

    const response = await fetch(url, {
      headers: {
        apikey: SUPABASE_CONFIG.publicKey,
        Authorization: `Bearer ${input.token}`,
      },
    });
    if (!response.ok) {
      throw new Error(`Relay usage query failed: HTTP ${response.status}`);
    }

    const data = parseRelayUsageRows(await response.json());
    rows.push(...data);
    if (data.length < USAGE_PAGE_SIZE) return rows;
  }
}

function roundCurrency(value: number): number {
  return Number(value.toFixed(6));
}
