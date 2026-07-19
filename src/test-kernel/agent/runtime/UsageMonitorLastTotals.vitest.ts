// Third-party imports
import { ModelProvider } from 'llm-zoo';
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { TraceEmitter } from '@agent/trace';
import {
  AgentRunStateSnapshotSchema,
  recordCycleMetrics,
} from '@agent/core/state/AgentState';
import { recordNormalizedUsage } from '@agent/core/usage/RunUsageAccumulator';
import { UsageMonitor } from '@agent/utils/UsageMonitor';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import {
  AgentCategory,
  type StorageKey,
  type StreamTabId,
} from '@shared/schemas';
import {
  USAGE_LOG_FLUSH_OUTCOME,
  UsageLogService,
} from '@telemetry/UsageLogService';

import { recordSessionEvents, runEventsOfType } from '../progressTestUtils';

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
    { logger, storageKey, streamId },
    { agentName: 'assistant', agentCategory: AgentCategory.ToolUse },
  );
  return {
    monitor,
    logger,
    events: recorded.events,
    dispose: () => {
      recorded.detach();
      detachTrace();
    },
  };
}

describe('UsageMonitor', () => {
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
      expect(usageEvent?.payload).toMatchObject({
        usage: {
          usageRoute: 'chatgpt-subscription',
        },
      });
      expect(usageEvent?.payload.usage).not.toHaveProperty(
        'viaChatGptSubscription',
      );
    } finally {
      dispose();
    }
  });

  it('does not replay prior usage during a usage-less tool-use continuation', async () => {
    const { dispose, events, monitor } = createMonitorWithEvents();
    const log = vi.spyOn(UsageLogService, 'log').mockImplementation(() => {});
    try {
      const state = AgentRunStateSnapshotSchema.parse({});
      const usage = {
        inputTokens: 10,
        outputTokens: 2,
        cost: 0.01,
        responseTimeMs: 50,
        provider: 'openai' as const,
      };
      recordCycleMetrics(state, 50, usage);
      await monitor.recordUsage(state);

      recordCycleMetrics(state, 25, null);
      expect(state.usageAccumulator.latestUsage).toBeNull();
      await monitor.recordUsage(state);

      expect(runEventsOfType(events, 'usage')).toHaveLength(1);
      expect(log).toHaveBeenCalledTimes(1);
      expect(monitor.lastTotals()).toBe(state.usageAccumulator.totals);
      expect(state.usageAccumulator.totals).toMatchObject({
        totalInputTokens: 10,
        totalOutputTokens: 2,
      });
    } finally {
      log.mockRestore();
      dispose();
    }
  });

  it('reports permanent relay rejection to the spend-cap caller', async () => {
    const { dispose, logger, monitor } = createMonitorWithEvents();
    const error = vi.spyOn(logger, 'error');
    const log = vi.spyOn(UsageLogService, 'log').mockImplementation(() => {});
    const flush = vi
      .spyOn(UsageLogService, 'flush')
      .mockResolvedValue(USAGE_LOG_FLUSH_OUTCOME.REJECTED);

    try {
      const state = AgentRunStateSnapshotSchema.parse({});
      recordNormalizedUsage(state.usageAccumulator, {
        inputTokens: 10,
        outputTokens: 2,
        cost: 0.01,
        responseTimeMs: 50,
        provider: 'openai-response',
        usageRoute: 'relay',
      });

      await monitor.recordUsage(state);

      expect(error).toHaveBeenCalledWith(
        'Relay usage logging was permanently rejected; spend-cap accounting is incomplete.',
      );
    } finally {
      error.mockRestore();
      log.mockRestore();
      flush.mockRestore();
      dispose();
    }
  });
});
