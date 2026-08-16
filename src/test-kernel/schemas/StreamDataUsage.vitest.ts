import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import {
  emptyUsageStats,
  parseUsageData,
  sumUsageStats,
  UsageProviderSchema,
} from '@shared/schemas';

afterEach(() => {
  vi.restoreAllMocks();
});

function mockWarn(): MockInstance<typeof console.warn> {
  return vi.spyOn(console, 'warn').mockImplementation(() => {});
}

describe('stream data usage parsing', () => {
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

  it('coerces persisted usage fields and defaults missing cache counters', () => {
    const { usage } = parseUsageData({
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
      reasoningTokens: 0,
      cacheReadInputTokens: 0,
      cacheMissInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  it('drops a usage entry that legitimately parses to all-zero activity', () => {
    const { usage, unparsedRuns } = parseUsageData({
      run: { inputTokens: 0, outputTokens: 0, cost: 0 },
    });

    expect(usage.size).toBe(0);
    expect(unparsedRuns.size).toBe(0);
  });

  it('preserves (does not zero-and-drop) a run entry with non-finite numeric fields', () => {
    // Regression test for #7464: `inputTokens`/`outputTokens`/`cost` reject
    // non-finite values (NaN/Infinity), which previously threw inside the
    // per-entry schema and was silently caught to `emptyUsageStats()` — an
    // all-zero value that then vanished from the map entirely, permanently
    // erasing this run's real cost data on the next `writeUsage()`. It must
    // now be logged and handed back raw instead.
    const warnSpy = mockWarn();
    const { usage, unparsedRuns } = parseUsageData({
      run: {
        inputTokens: 'not-a-number',
        outputTokens: Number.POSITIVE_INFINITY,
        cost: Number.NaN,
      },
    });

    expect(usage.has('run')).toBe(false);
    expect(unparsedRuns.get('run')).toEqual({
      inputTokens: 'not-a-number',
      outputTokens: Number.POSITIVE_INFINITY,
      cost: Number.NaN,
    });
    expect(warnSpy).toHaveBeenCalled();
  });

  it('parses numeric usage fields from the canonical usage schema shape', () => {
    const { usage } = parseUsageData({
      run: {
        inputTokens: '10',
        outputTokens: '2',
        cost: '0',
        cacheReadInputTokens: '3',
        usageRoute: 'chatgpt-subscription',
      },
    });

    expect(usage.get('run')).toMatchObject({
      cacheReadInputTokens: 3,
      cacheMissInputTokens: 0,
      cacheCreationInputTokens: 0,
      usageRoute: 'chatgpt-subscription',
    });
  });

  it.each([
    ['retired subscription marker', { viaChatGptSubscription: true }],
    ['usage route', { usageRoute: 'unknown-route' }],
  ])('preserves a run with a malformed %s', (_field, malformedField) => {
    const warnSpy = mockWarn();
    const rawRun = {
      inputTokens: 10,
      outputTokens: 2,
      cost: 0.1,
      ...malformedField,
    };

    const { usage, unparsedRuns } = parseUsageData({ run: rawRun });

    expect(usage.has('run')).toBe(false);
    expect(unparsedRuns.get('run')).toEqual(rawRun);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('preserves an unparseable run entry instead of silently zeroing it', () => {
    // Regression test for #7464: a run entry that isn't an object at all
    // (e.g. corrupted to a bare string) must not be replaced by zeroed
    // usage and dropped — it must be logged and handed back raw so a save
    // never permanently deletes it.
    const warnSpy = mockWarn();
    const { usage, unparsedRuns } = parseUsageData({
      good: { inputTokens: 10, outputTokens: 2, cost: 0.1 },
      corrupted: 'not-a-usage-object',
    });

    expect(usage.has('corrupted')).toBe(false);
    expect(usage.get('good')).toMatchObject({ inputTokens: 10 });
    expect(unparsedRuns.get('corrupted')).toBe('not-a-usage-object');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('logs and yields no data for a top-level usage payload that is not an object', () => {
    const warnSpy = mockWarn();
    const { usage, unparsedRuns } = parseUsageData(['not', 'a', 'record']);

    expect(usage.size).toBe(0);
    expect(unparsedRuns.size).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
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
