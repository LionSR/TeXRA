import { deepStrictEqual, equal } from 'node:assert/strict';

import { Result, Schema } from 'effect';

import {
  subscriptionSourceForUsage,
  UsageBatchSchema,
  UsageLogEntrySchema,
} from '../_shared/usageValidation.ts';

const parseEntry = Schema.decodeUnknownSync(UsageLogEntrySchema);
const parseBatch = Schema.decodeUnknownSync(UsageBatchSchema);
const isEntry = (input: unknown) =>
  Result.isSuccess(Schema.decodeUnknownResult(UsageLogEntrySchema)(input));
const isBatch = (input: unknown) =>
  Result.isSuccess(Schema.decodeUnknownResult(UsageBatchSchema)(input));

const VALID_BATCH_ID = 'a584b784-a4f1-4d44-a99f-36767d31e79d';

function usageEntry() {
  return {
    timestamp: '2026-07-12T12:00:00.000Z',
    model: 'gpt-5',
    provider: 'openai-responses',
    inputTokens: 10,
    outputTokens: 5,
    cost: 0.01,
  };
}

Deno.test('normalizes only missing optional usage fields', () => {
  const parsed = parseEntry(usageEntry());

  equal(parsed.usageRoute, undefined);
  equal(parsed.usedRelay, undefined);
  equal(Object.hasOwn(parsed, 'viaChatGptSubscription'), false);
});

Deno.test(
  'derives the legacy subscription route from an explicit boolean',
  () => {
    const parsed = parseEntry({
      ...usageEntry(),
      viaChatGptSubscription: true,
    });

    equal(parsed.usageRoute, 'chatgpt-subscription');
  },
);

Deno.test(
  'classifies Kimi Code usage under the Kimi subscription source',
  () => {
    const parsed = parseEntry({
      ...usageEntry(),
      model: 'k3',
      provider: 'openai-responses',
      usageRoute: 'kimi-code-subscription',
    });

    equal(subscriptionSourceForUsage(parsed), 'kimi');
  },
);

Deno.test('classifies GLM Coding Plan usage under the GLM source', () => {
  const parsed = parseEntry({
    ...usageEntry(),
    model: 'glm-5',
    provider: 'openai-responses',
    usageRoute: 'glm-coding-plan-subscription',
  });

  equal(subscriptionSourceForUsage(parsed), 'glm');
});

Deno.test('classifies Grok usage under the grok subscription source', () => {
  const parsed = parseEntry({
    ...usageEntry(),
    model: 'grok-5',
    provider: 'openai-responses',
    usageRoute: 'xai-subscription',
  });

  equal(subscriptionSourceForUsage(parsed), 'grok');
});

Deno.test('keeps paid usage outside subscription sources', () => {
  const parsed = parseEntry({
    ...usageEntry(),
    usageRoute: 'api-key',
  });

  equal(subscriptionSourceForUsage(parsed), undefined);
});

Deno.test('accepts a nonempty batch of valid entries', () => {
  const parsed = parseBatch({
    batchId: VALID_BATCH_ID,
    entries: [usageEntry()],
  });

  equal(parsed.batchId, VALID_BATCH_ID);
  equal(parsed.entries.length, 1);
});

Deno.test('rejects invalid present optional fields', () => {
  const invalidEntries = [
    { ...usageEntry(), usedRelay: 'yes' },
    { ...usageEntry(), responseTimeMs: -1 },
    { ...usageEntry(), viaChatGptSubscription: 'true' },
  ];

  deepStrictEqual(
    invalidEntries.map(isEntry),
    invalidEntries.map(() => false),
  );
});

Deno.test('accepts a mixed batch with a legacy relay entry', () => {
  const parsed = isBatch({
    batchId: VALID_BATCH_ID,
    entries: [
      usageEntry(),
      { ...usageEntry(), usageRoute: 'relay', usedRelay: true },
    ],
  });

  equal(parsed, true);
});

Deno.test('rejects a whole batch when any entry is invalid', () => {
  const parsed = isBatch({
    batchId: VALID_BATCH_ID,
    entries: [usageEntry(), { ...usageEntry(), inputTokens: -1 }],
  });

  equal(parsed, false);
});

Deno.test('rejects empty usage batches', () => {
  const parsed = isBatch({
    batchId: VALID_BATCH_ID,
    entries: [],
  });

  equal(parsed, false);
});
