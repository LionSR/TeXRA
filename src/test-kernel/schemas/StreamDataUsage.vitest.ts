import { describe, expect, it } from 'vitest';

import { UsageDataSchema } from '@shared/schemas';

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
});
