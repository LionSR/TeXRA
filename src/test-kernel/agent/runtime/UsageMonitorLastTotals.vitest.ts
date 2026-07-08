// Third-party imports
import { ModelProvider } from 'llm-zoo';
import { describe, expect, it } from 'vitest';

// Local imports
import { TraceEmitter } from '@agent/trace';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import { recordNormalizedUsage } from '@agent/core/usage/RunUsageAccumulator';
import { UsageMonitor } from '@agent/utils/UsageMonitor';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import {
  AgentCategory,
  type StorageKey,
  type StreamTabId,
} from '@shared/schemas';

import {
  createRecordingHost,
  recordSessionEvents,
  runEventsOfType,
} from '../progressTestUtils';

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
  const { host } = createRecordingHost();
  const logger = new TraceEmitter();
  const hub = new SessionEventHub();
  const storageKey = 'usage-last-totals' as StorageKey;
  const streamId = 'stream:usage-last-totals' as StreamTabId;
  const recorded = recordSessionEvents(hub, { scope: 'run' });
  const detachTrace = logger.subscribe((event) =>
    hub.emit({ scope: 'run', streamId, event }),
  );
  const monitor = new UsageMonitor(
    modelInfo,
    { logger, runtimeHost: host, storageKey, streamId },
    { agentName: 'assistant', agentCategory: AgentCategory.ToolUse },
  );
  return {
    monitor,
    events: recorded.events,
    dispose: () => {
      recorded.detach();
      detachTrace();
    },
  };
}

describe('UsageMonitor.lastTotals (SDK Step 7d PR 5)', () => {
  it('is undefined before any round and caches the totals after recordUsage', async () => {
    const { dispose, monitor } = createMonitorWithEvents();
    try {
      expect(monitor.lastTotals()).toBeUndefined();

      const state = AgentRunStateSnapshotSchema.parse({});
      await monitor.recordUsage(state);

      // The cache holds the exact totals object the accumulator exposed, so a
      // failed run's terminal `result` event can report usage from the catch arm.
      expect(monitor.lastTotals()).toBe(state.usageAccumulator.totals);
    } finally {
      dispose();
    }
  });

  it('forwards the ChatGPT subscription route to session usage facts', async () => {
    const { dispose, events, monitor } = createMonitorWithEvents();
    try {
      const state = AgentRunStateSnapshotSchema.parse({});
      recordNormalizedUsage(state.usageAccumulator, {
        inputTokens: 10,
        outputTokens: 2,
        cost: 0,
        responseTimeMs: 50,
        provider: 'openai-response',
        usageRoute: 'chatgpt-subscription',
      });

      await monitor.recordUsage(state);

      const usageEvent = runEventsOfType(events, 'usage').at(0);
      const usageData = usageEvent?.data as
        { usage?: Record<string, unknown> } | undefined;
      expect(usageData).toMatchObject({
        usage: {
          usageRoute: 'chatgpt-subscription',
        },
      });
      expect(usageData?.usage).not.toHaveProperty('viaChatGptSubscription');
    } finally {
      dispose();
    }
  });
});
