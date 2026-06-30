// Third-party imports
import { ModelProvider } from 'llm-zoo';
import { beforeAll, describe, expect, it } from 'vitest';

// Local imports
import { noopTrace } from '@agent/trace';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import { recordNormalizedUsage } from '@agent/core/usage/RunUsageAccumulator';
import { UsageMonitor } from '@agent/utils/UsageMonitor';
import {
  AgentCategory,
  type StorageKey,
  type StreamTabId,
} from '@shared/schemas';

import { createRecordingHost } from '../progressTestUtils';

const modelInfo = {
  capabilities: {
    supportsPromptCaching: false,
    supportsAutoPromptCaching: false,
    supportsReasoning: false,
    cacheDiscountFactor: 0,
  },
  config: {
    provider: ModelProvider.OPENAI,
    name: 'test-model',
    fullName: 'Test Model',
    inputPrice: 0,
    openRouterOnly: false,
    requiresResponsesAPI: false,
  },
};

function createMonitorWithEvents() {
  const { host, events } = createRecordingHost();
  const storageKey = 'usage-last-totals' as StorageKey;
  const streamId = 'stream:usage-last-totals' as StreamTabId;
  const monitor = new UsageMonitor(
    modelInfo,
    { logger: noopTrace, runtimeHost: host, storageKey, streamId },
    { agentName: 'assistant', agentCategory: AgentCategory.ToolUse },
  );
  return { monitor, events };
}

function createMonitor(): UsageMonitor {
  return createMonitorWithEvents().monitor;
}

describe('UsageMonitor.lastTotals (SDK Step 7d PR 5)', () => {
  beforeAll(async () => {
    const [{ initPlatform }, { createFakePlatform }] = await Promise.all([
      import('@platform/platform'),
      import('@test/support/FakePlatform'),
    ]);
    initPlatform(createFakePlatform());
  });

  it('is undefined before any round and caches the totals after recordUsage', async () => {
    const monitor = createMonitor();
    expect(monitor.lastTotals()).toBeUndefined();

    const state = AgentRunStateSnapshotSchema.parse({});
    await monitor.recordUsage(state);

    // The cache holds the exact totals object the accumulator exposed, so a
    // failed run's terminal `result` event can report usage from the catch arm.
    expect(monitor.lastTotals()).toBe(state.usageAccumulator.totals);
  });

  it('forwards the ChatGPT subscription marker to progress usage events', async () => {
    const { monitor, events } = createMonitorWithEvents();
    const state = AgentRunStateSnapshotSchema.parse({});
    recordNormalizedUsage(state.usageAccumulator, {
      inputTokens: 10,
      outputTokens: 2,
      cost: 0,
      responseTimeMs: 50,
      provider: 'openai-response',
      viaChatGptSubscription: true,
    });

    await monitor.recordUsage(state);

    const usageEvent = events.find(
      (event) => event.event === 'updateStreamUsage',
    );
    expect(usageEvent?.payload).toMatchObject({
      usage: {
        viaChatGptSubscription: true,
        usageRoute: 'chatgpt-subscription',
      },
    });
  });
});
