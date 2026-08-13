import { deepStrictEqual, equal } from 'node:assert/strict';

import {
  subscriptionSourceForUsage,
  UsageBatchSchema,
  UsageLogEntrySchema,
} from './usageValidation.ts';

const VALID_BATCH_ID = 'a584b784-a4f1-4d44-a99f-36767d31e79d';

function usageEntry() {
  return {
    timestamp: '2026-07-12T12:00:00.000Z',
    model: 'gpt-5',
    provider: 'openai',
    inputTokens: 10,
    outputTokens: 5,
    cost: 0.01,
  };
}

Deno.test('normalizes only missing optional usage fields', () => {
  const parsed = UsageLogEntrySchema.parse(usageEntry());

  equal(parsed.usageRoute, undefined);
  equal(parsed.usedRelay, undefined);
  equal(Object.hasOwn(parsed, 'viaChatGptSubscription'), false);
});

Deno.test(
  'derives the legacy subscription route from an explicit boolean',
  () => {
    const parsed = UsageLogEntrySchema.parse({
      ...usageEntry(),
      viaChatGptSubscription: true,
    });

    equal(parsed.usageRoute, 'chatgpt-subscription');
  },
);

Deno.test(
  'classifies Kimi Code usage under the Kimi subscription source',
  () => {
    const parsed = UsageLogEntrySchema.parse({
      ...usageEntry(),
      model: 'k3',
      provider: 'moonshot',
      usageRoute: 'kimi-code-subscription',
    });

    equal(subscriptionSourceForUsage(parsed), 'kimi');
  },
);

Deno.test('classifies GLM Coding Plan usage under the GLM source', () => {
  const parsed = UsageLogEntrySchema.parse({
    ...usageEntry(),
    model: 'glm-5',
    provider: 'glm',
    usageRoute: 'glm-coding-plan-subscription',
  });

  equal(subscriptionSourceForUsage(parsed), 'glm');
});

Deno.test('classifies Grok usage under the xai subscription source', () => {
  const parsed = UsageLogEntrySchema.parse({
    ...usageEntry(),
    model: 'grok-5',
    provider: 'xai',
    usageRoute: 'xai-subscription',
  });

  equal(subscriptionSourceForUsage(parsed), 'xai');
});

Deno.test('keeps paid usage outside subscription sources', () => {
  const parsed = UsageLogEntrySchema.parse({
    ...usageEntry(),
    usageRoute: 'api-key',
  });

  equal(subscriptionSourceForUsage(parsed), undefined);
});

Deno.test('accepts a nonempty batch of valid entries', () => {
  const parsed = UsageBatchSchema.parse({
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
    invalidEntries.map((entry) => UsageLogEntrySchema.safeParse(entry).success),
    invalidEntries.map(() => false),
  );
});

Deno.test('rejects a whole batch when any entry is invalid', () => {
  const parsed = UsageBatchSchema.safeParse({
    batchId: VALID_BATCH_ID,
    entries: [usageEntry(), { ...usageEntry(), inputTokens: -1 }],
  });

  equal(parsed.success, false);
});

Deno.test('rejects empty usage batches', () => {
  const parsed = UsageBatchSchema.safeParse({
    batchId: VALID_BATCH_ID,
    entries: [],
  });

  equal(parsed.success, false);
});
