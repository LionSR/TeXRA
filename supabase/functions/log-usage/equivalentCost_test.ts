import { equal } from 'node:assert/strict';

import { equivalentListCost } from './equivalentCost.ts';

// gpt-5.6-sol list price: $4/M input, $20/M output, cache discount 0.1
// (prompts here stay under its 272K long-context tier). Its fast tier
// ($8/$40) must not be used.
Deno.test('prices a known model at standard-tier list price', () => {
  const cost = equivalentListCost({
    model: 'gpt-5.6-sol',
    inputTokens: 100_000,
    outputTokens: 10_000,
    cachedInputTokens: undefined,
    reasoningTokens: undefined,
  });

  equal(cost, 0.6); // 0.4 + 0.2
});

Deno.test('bills cached input at the cache-read discount', () => {
  const cost = equivalentListCost({
    model: 'gpt-5.6-sol',
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 100_000,
    reasoningTokens: undefined,
  });

  equal(cost, 0.04);
});

// OpenAI's output count already includes its reasoning tokens.
Deno.test('does not bill reasoning tokens twice', () => {
  const cost = equivalentListCost({
    model: 'gpt-5.6-sol',
    inputTokens: 0,
    outputTokens: 1_000_000,
    cachedInputTokens: undefined,
    reasoningTokens: 400_000,
  });

  equal(cost, 20);
});

Deno.test('resolves models reported by short name', () => {
  const cost = equivalentListCost({
    model: 'gpt-5.5',
    inputTokens: 100_000,
    outputTokens: 0,
    cachedInputTokens: undefined,
    reasoningTokens: undefined,
  });

  equal(cost, 0.5);
});

// A 300K prompt (200K miss + 100K cached) is above gpt-6.1-sol's 272K tier,
// so the whole request bills at $4 / $15 with the 0.05 cache factor.
Deno.test('bills a long prompt at the long-context tier', () => {
  const cost = equivalentListCost({
    model: 'gpt-6.1-sol',
    inputTokens: 200_000,
    outputTokens: 10_000,
    cachedInputTokens: 100_000,
    reasoningTokens: undefined,
  });

  equal(cost, 0.97); // 0.8 + 0.02 + 0.15
});

Deno.test('returns undefined for models without a registry entry', () => {
  const cost = equivalentListCost({
    model: 'not-a-real-model',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cachedInputTokens: undefined,
    reasoningTokens: undefined,
  });

  equal(cost, undefined);
});
