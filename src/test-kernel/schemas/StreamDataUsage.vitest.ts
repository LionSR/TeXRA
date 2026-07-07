import { describe, expect, it, vi } from 'vitest';

import {
  emptyUsageStats,
  sumUsageStats,
  UsageDataSchema,
} from '@shared/schemas';

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
    });
  });

  it('drops malformed persisted usage entries instead of zeroing them', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const usage = UsageDataSchema.parse({
      nonFinite: {
        inputTokens: 'not-a-number',
        outputTokens: Number.POSITIVE_INFINITY,
        cost: Number.NaN,
      },
      negative: {
        inputTokens: -1,
        outputTokens: 2,
        cost: 0,
      },
      missingRequired: {
        inputTokens: 1,
        cost: 0,
      },
      unknownRoute: {
        inputTokens: 1,
        outputTokens: 2,
        cost: 0,
        usageRoute: 'future-route',
      },
    });

    expect(usage.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });

  it('warns and drops a malformed usage map', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const usage = UsageDataSchema.parse(['not', 'a', 'record']);

    expect(usage.size).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('parses numeric usage fields from the canonical usage schema shape', () => {
    const usage = UsageDataSchema.parse({
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
    const usage = UsageDataSchema.parse({
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
