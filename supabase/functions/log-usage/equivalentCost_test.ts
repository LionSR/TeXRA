import { equal } from 'node:assert/strict';

import { equivalentListCost } from './equivalentCost.ts';

// gpt-5.6-sol list price in llm-zoo@1.28.0: $5/M input, $30/M output,
// cache discount 0.1. The fast-tier registry entry for the same model id
// ($10/$60) must not be selected.
Deno.test('prices a known model at standard-tier list price', () => {
  const cost = equivalentListCost({
    model: 'gpt-5.6-sol',
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cachedInputTokens: undefined,
    reasoningTokens: undefined,
  });

  equal(cost, 5 + 3);
});

Deno.test('bills cached input at the cache-read discount', () => {
  const cost = equivalentListCost({
    model: 'gpt-5.6-sol',
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 1_000_000,
    reasoningTokens: undefined,
  });

  equal(cost, 0.5);
});

Deno.test('bills reasoning tokens at the output rate', () => {
  const cost = equivalentListCost({
    model: 'gpt-5.6-sol',
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: undefined,
    reasoningTokens: 1_000_000,
  });

  equal(cost, 30);
});

Deno.test('resolves models reported by short name', () => {
  const cost = equivalentListCost({
    model: 'gpt-5.5',
    inputTokens: 1_000_000,
    outputTokens: 0,
    cachedInputTokens: undefined,
    reasoningTokens: undefined,
  });

  equal(cost, 5);
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
