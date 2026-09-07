import { describe, expect, it } from 'vitest';

import {
  emptyUsageStats,
  sumUsageStats,
  UsageProviderSchema,
} from '@shared/schemas';

describe('usage wire vocabulary and aggregation', () => {
  it('preserves the exact usage-provider wire vocabulary', () => {
    expect(UsageProviderSchema.options).toEqual([
      'anthropic',
      'openai',
      'openai-response',
      'google',
      'deepseek',
      'openrouter',
      'dashscope',
      'xai',
      'moonshot',
      'minimax',
      'glm',
      'meta',
      'unknown',
    ]);
  });

  it.each<{
    name: string;
    entries: Parameters<typeof sumUsageStats>[0];
    expectedRoute: string | undefined;
  }>([
    {
      name: 'kept when every active entry shares the route',
      entries: [
        emptyUsageStats(),
        { inputTokens: 10, outputTokens: 2, cost: 0, usageRoute: 'relay' },
        {
          inputTokens: 1,
          outputTokens: 1,
          cost: 0.001,
          usageRoute: 'relay',
        },
      ],
      expectedRoute: 'relay',
    },
    {
      name: 'dropped when accumulated entries mix routes',
      entries: [
        { inputTokens: 10, outputTokens: 2, cost: 0, usageRoute: 'relay' },
        {
          inputTokens: 1,
          outputTokens: 1,
          cost: 0.001,
          usageRoute: 'api-key',
        },
      ],
      expectedRoute: undefined,
    },
    {
      name: 'kept for a single subscription-routed entry',
      entries: [
        {
          inputTokens: 10,
          outputTokens: 2,
          cost: 0,
          usageRoute: 'chatgpt-subscription',
        },
      ],
      expectedRoute: 'chatgpt-subscription',
    },
  ])(
    'keeps route badges only for unambiguous accumulated usage: $name',
    ({ entries, expectedRoute }) => {
      const summed = sumUsageStats(entries);

      if (expectedRoute === undefined) {
        expect(summed).not.toHaveProperty('usageRoute');
      } else {
        expect(summed.usageRoute).toBe(expectedRoute);
      }
    },
  );
});
