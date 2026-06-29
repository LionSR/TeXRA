// Third-party imports
import { ModelProvider } from 'llm-zoo';
import { beforeAll, describe, expect, it } from 'vitest';

// Local imports
import { noopTrace } from '@agent/trace';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
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

function createMonitor(): UsageMonitor {
  const { host } = createRecordingHost();
  const storageKey = 'usage-last-totals' as StorageKey;
  const streamId = 'stream:usage-last-totals' as StreamTabId;
  return new UsageMonitor(
    modelInfo,
    { logger: noopTrace, runtimeHost: host, storageKey, streamId },
    { agentName: 'assistant', agentCategory: AgentCategory.ToolUse },
  );
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
});
