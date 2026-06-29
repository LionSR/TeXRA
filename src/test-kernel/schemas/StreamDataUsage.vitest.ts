import { describe, expect, it } from 'vitest';

import { sumUsageStats, UsageDataSchema } from '@shared/schemas';

describe('stream data usage parsing', () => {
  it('coerces persisted usage fields and defaults missing cache counters', () => {
    const usage = UsageDataSchema.parse({
      run: {
        inputTokens: '10',
        outputTokens: '2',
        cost: '0.25',
      },
    });

    expect(usage.get('run')).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      cost: 0.25,
      cacheReadInputTokens: 0,
      cacheMissInputTokens: 0,
      cacheCreationInputTokens: 0,
      viaChatGptSubscription: false,
    });
  });

  it('drops usage entries that parse to empty defaults', () => {
    const usage = UsageDataSchema.parse({
      run: {
        inputTokens: 'not-a-number',
        outputTokens: Number.POSITIVE_INFINITY,
        cost: Number.NaN,
      },
    });

    expect(usage.size).toBe(0);
  });

  it('parses numeric usage fields from the canonical usage schema shape', () => {
    const usage = UsageDataSchema.parse({
      run: {
        inputTokens: '10',
        outputTokens: '2',
        cost: '0',
        cacheReadInputTokens: '3',
        viaChatGptSubscription: true,
      },
    });

    expect(usage.get('run')).toMatchObject({
      cacheReadInputTokens: 3,
      cacheMissInputTokens: 0,
      cacheCreationInputTokens: 0,
      viaChatGptSubscription: true,
    });
  });

  it('marks accumulated usage as subscription usage only when every round is subscription usage', () => {
    expect(
      sumUsageStats([
        {
          inputTokens: 10,
          outputTokens: 2,
          cost: 0,
          viaChatGptSubscription: true,
        },
        {
          inputTokens: 1,
          outputTokens: 1,
          cost: 0.001,
          viaChatGptSubscription: false,
        },
      ]).viaChatGptSubscription,
    ).toBe(false);

    expect(
      sumUsageStats([
        {
          inputTokens: 10,
          outputTokens: 2,
          cost: 0,
          viaChatGptSubscription: true,
        },
      ]).viaChatGptSubscription,
    ).toBe(true);
  });
});
