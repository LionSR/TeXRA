import { afterEach, describe, expect, it, vi } from 'vitest';

import { TraceEmitter } from '@agent/trace';
import {
  AgentRunStateSnapshotSchema,
  recordCycleMetrics,
} from '@agent/core/state/AgentState';
import { recordNormalizedUsage } from '@agent/core/usage/RunUsageAccumulator';
import { UsageMonitor } from '@agent/runtime/UsageMonitor';
import type { RunModelHandler } from '@agent/runtime/ModelCell';
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

// Local file imports
import { testModelCell } from '../modelCellTestUtils';
import { recordSessionEvents, runEventsOfType } from '../progressTestUtils';
import { testModelInfo } from '../runtime/launchContextTestUtils';

// One restore after each test covers every vi.spyOn in this file.
afterEach(() => {
  vi.restoreAllMocks();
});

type MonitorContext = ReturnType<typeof createMonitorWithEvents>;

function createMonitorWithEvents() {
  const logger = new TraceEmitter();
  const hub = new SessionEventHub();
  const storageKey = 'usage-last-totals' as StorageKey;
  const streamId = 'stream:usage-last-totals' as StreamTabId;
  const recorded = recordSessionEvents(hub, { scope: 'run' });
  const detachTrace = logger.subscribe((event) =>
    hub.emit({ scope: 'run', streamId, event }),
  );
  const modelCell = testModelCell({ ...testModelInfo, dispose: vi.fn() });
  const monitor = new UsageMonitor(
    modelCell,
    { logger, storageKey, streamId },
    { agentName: 'assistant', agentCategory: AgentCategory.ToolUse },
  );
  return {
    monitor,
    modelCell,
    logger,
    events: recorded.events,
    dispose: () => {
      recorded.detach();
      detachTrace();
    },
  };
}

/** Run `fn` against a fresh monitor that is always disposed. */
async function withMonitor<T>(
  fn: (ctx: MonitorContext) => Promise<T>,
): Promise<T> {
  const ctx = createMonitorWithEvents();
  try {
    return await fn(ctx);
  } finally {
    ctx.dispose();
  }
}

describe('UsageMonitor', () => {
  it('is undefined before any round and caches the totals after recordUsage', async () => {
    await withMonitor(async ({ monitor }) => {
      expect(monitor.lastTotals()).toBeUndefined();

      const state = AgentRunStateSnapshotSchema.parse({});
      await monitor.recordUsage(state);

      // The cache holds the exact totals object the accumulator exposed, so a
      // failed run's terminal `result` event can report usage from the catch arm.
      expect(monitor.lastTotals()).toBe(state.usageAccumulator.totals);
    });
  });

  it('forwards the ChatGPT subscription route to session usage facts', async () => {
    await withMonitor(async ({ monitor, events }) => {
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
    });
  });

  it('does not replay prior usage during a usage-less tool-use continuation', async () => {
    await withMonitor(async ({ monitor, events }) => {
      const log = vi.spyOn(UsageLogService, 'log').mockImplementation(() => {});
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
    });
  });

  it('bills a round against the model the run switched to', async () => {
    await withMonitor(async ({ monitor, modelCell }) => {
      const log = vi.spyOn(UsageLogService, 'log').mockImplementation(() => {});
      modelCell.swap(
        {
          ...testModelInfo,
          config: { ...testModelInfo.config, fullName: 'Switched Model' },
          dispose: vi.fn(),
        } as unknown as RunModelHandler,
        'switched-model',
      );

      const state = AgentRunStateSnapshotSchema.parse({});
      recordCycleMetrics(state, 50, {
        inputTokens: 10,
        outputTokens: 2,
        cost: 0.01,
        responseTimeMs: 50,
        provider: 'openai' as const,
      });
      await monitor.recordUsage(state);

      // Nothing pushes the new model in: the monitor reads the live handler
      // out of the run's ModelCell on every round.
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'Switched Model' }),
      );
    });
  });

  it('warns when an invalid provider blocks backend usage accounting', async () => {
    await withMonitor(async ({ logger, monitor, modelCell }) => {
      const warn = vi.spyOn(logger, 'warn');
      const log = vi.spyOn(UsageLogService, 'log').mockImplementation(() => {});
      modelCell.swap(
        {
          ...testModelInfo,
          config: { ...testModelInfo.config, provider: 'invalid-provider' },
          dispose: vi.fn(),
        } as unknown as RunModelHandler,
        'invalid-provider-model',
      );
      const state = AgentRunStateSnapshotSchema.parse({});
      recordCycleMetrics(state, 50, {
        inputTokens: 10,
        outputTokens: 2,
        cost: 0.01,
        responseTimeMs: 50,
        provider: 'openai' as const,
      });

      await monitor.recordUsage(state);

      expect(log).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        'Backend usage logging failed',
        expect.objectContaining({ data: expect.anything() }),
      );
    });
  });

  it('reports permanent relay rejection to the spend-cap caller', async () => {
    await withMonitor(async ({ logger, monitor }) => {
      const error = vi.spyOn(logger, 'error');
      vi.spyOn(UsageLogService, 'log').mockImplementation(() => {});
      vi.spyOn(UsageLogService, 'flush').mockResolvedValue(
        USAGE_LOG_FLUSH_OUTCOME.REJECTED,
      );

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
    });
  });
});
