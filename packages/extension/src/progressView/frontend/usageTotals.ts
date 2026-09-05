import { sumUsageStats, type TokenUsageStats } from '@shared/schemas';

type RunUsageMap = Record<string, TokenUsageStats>;

/**
 * Session-total usage for one stream, summed over its per-run map. Memoized
 * by the map's identity: the fold keeps `usage` reference-stable across
 * unrelated ticks, so the stream-content components hand the usage panel
 * the same total object instead of re-summing (and re-rendering) on every
 * render.
 */
const runUsageTotals = new WeakMap<RunUsageMap, TokenUsageStats>();
export function totalRunUsage(runUsage: RunUsageMap): TokenUsageStats {
  const cached = runUsageTotals.get(runUsage);
  if (cached) return cached;
  const total = sumUsageStats(Object.values(runUsage));
  runUsageTotals.set(runUsage, total);
  return total;
}
