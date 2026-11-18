/**
 * Which token counts a usage record shows, in what order and under what
 * name: the progress view's usage strip and the VS Code task pill's tooltip
 * read the same list, so neither picks its own facts.
 */
import type { TokenUsageStats } from '@texra-ai/harness/schemas';

/** The counters in order. Only the `always` ones show at zero; the rest
 *  stay hidden until the run reports them. `note` qualifies the name where
 *  there is room (a tooltip). */
const TOKEN_USAGE_STATS = Object.freeze([
  Object.freeze({ key: 'inputTokens', label: 'Input tokens', always: true }),
  Object.freeze({
    key: 'cachedInputTokens',
    label: 'Cache read tokens',
    note: 'discounted',
  }),
  Object.freeze({
    key: 'cacheMissInputTokens',
    label: 'Cache miss tokens',
    note: 'full price',
  }),
  Object.freeze({
    key: 'cacheWriteTokens',
    label: 'Cache creation tokens',
    note: '1.25× cost',
  }),
  Object.freeze({ key: 'outputTokens', label: 'Output tokens', always: true }),
  Object.freeze({ key: 'reasoningTokens', label: 'Reasoning tokens' }),
] as const satisfies readonly {
  key: keyof TokenUsageStats;
  label: string;
  note?: string;
  always?: true;
}[]);

/** One counter a usage record shows, with its value. */
export type TokenUsageStat = (typeof TOKEN_USAGE_STATS)[number] & {
  readonly value: number;
};

/** The counters `usage` shows, in order, each with its value. */
export function visibleTokenStats(usage: TokenUsageStats): TokenUsageStat[] {
  return TOKEN_USAGE_STATS.flatMap((stat) => {
    const value = usage[stat.key] ?? 0;
    return 'always' in stat || value > 0 ? [{ ...stat, value }] : [];
  });
}
