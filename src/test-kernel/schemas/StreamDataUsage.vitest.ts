import { describe, expect, it, vi } from 'vitest';

import {
  emptyUsageStats,
  parseUsageData,
  sumUsageStats,
  UsageProviderSchema,
} from '@shared/schemas';

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
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    warnSpy.mockRestore();
  });

  it('parses numeric usage fields from the canonical usage schema shape', () => {
    const { usage } = parseUsageData({
      run: {
        inputTokens: '10',
        outputTokens: '2',
        cost: '0',
        cacheReadInputTokens: '3',
        viaChatGptSubscription: true,
        usageRoute: 'chatgpt-subscription',
      },
    });

    expect(usage.get('run')).toMatchObject({
      cacheReadInputTokens: 3,
      cacheMissInputTokens: 0,
      cacheCreationInputTokens: 0,
      usageRoute: 'chatgpt-subscription',
    });
    expect(usage.get('run')).not.toHaveProperty('viaChatGptSubscription');
  });

  it('normalizes persisted legacy subscription markers to usageRoute', () => {
    const { usage } = parseUsageData({
      run: {
        inputTokens: 10,
        outputTokens: 2,
        cost: 0,
        viaChatGptSubscription: true,
      },
    });

    expect(usage.get('run')).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
      cost: 0,
      usageRoute: 'chatgpt-subscription',
    });
    expect(usage.get('run')).not.toHaveProperty('viaChatGptSubscription');
  });

  it('preserves an unparseable run entry instead of silently zeroing it', () => {
    // Regression test for #7464: a run entry that isn't an object at all
    // (e.g. corrupted to a bare string) must not be replaced by zeroed
    // usage and dropped — it must be logged and handed back raw so a save
    // never permanently deletes it.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { usage, unparsedRuns } = parseUsageData({
      good: { inputTokens: 10, outputTokens: 2, cost: 0.1 },
      corrupted: 'not-a-usage-object',
    });

    expect(usage.has('corrupted')).toBe(false);
    expect(usage.get('good')).toMatchObject({ inputTokens: 10 });
    expect(unparsedRuns.get('corrupted')).toBe('not-a-usage-object');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('logs and yields no data for a top-level usage payload that is not an object', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { usage, unparsedRuns } = parseUsageData(['not', 'a', 'record']);

    expect(usage.size).toBe(0);
    expect(unparsedRuns.size).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('keeps route badges only for unambiguous accumulated usage', () => {
    expect(
      sumUsageStats([
        emptyUsageStats(),
        {
          inputTokens: 10,
          outputTokens: 2,
          cost: 0,
          usageRoute: 'relay',
        },
        {
          inputTokens: 1,
          outputTokens: 1,
          cost: 0.001,
          usageRoute: 'relay',
        },
      ]).usageRoute,
    ).toBe('relay');

    expect(
      sumUsageStats([
        {
          inputTokens: 10,
          outputTokens: 2,
          cost: 0,
          usageRoute: 'relay',
        },
        {
          inputTokens: 1,
          outputTokens: 1,
          cost: 0.001,
          usageRoute: 'api-key',
        },
      ]),
    ).not.toHaveProperty('usageRoute');

    expect(
      sumUsageStats([
        {
          inputTokens: 10,
          outputTokens: 2,
          cost: 0,
          usageRoute: 'chatgpt-subscription',
        },
      ]).usageRoute,
    ).toBe('chatgpt-subscription');
  });
});
