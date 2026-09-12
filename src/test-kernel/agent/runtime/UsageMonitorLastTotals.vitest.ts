import { ModelProvider } from 'llm-zoo';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TraceEmitter } from '@agent/trace';
import { UsageMonitor } from '@agent/runtime/UsageMonitor';
import {
  AgentCategory,
  AgentRunStateSnapshotSchema,
  type AgentRunStateSnapshot,
  type NormalizedUsage,
  type RunId,
} from '@shared/schemas';
import { UsageLogService } from '@telemetry/UsageLogService';

// Local file imports
import { recordTraceEvents, traceEventsOfType } from '../progressTestUtils';
import { testModelInfo } from '../runtime/launchContextTestUtils';

// One restore after each test covers every vi.spyOn in this file.
afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * One round's usage folded into the snapshot the monitor reads, the way the
 * loop's fold sums `response.usage` rows: totals accumulate, `latestUsage`
 * is the round's own figure (null for a usage-less continuation).
 */
function recordRound(
  state: AgentRunStateSnapshot,
  responseTimeMs: number,
  usage: NormalizedUsage | null,
): void {
  const acc = state.usageAccumulator;
  if (usage) {
    if (acc.totals.firstInputTokens === 0) {
      acc.totals.firstInputTokens = usage.inputTokens;
    }
    acc.totals.totalInputTokens += usage.inputTokens;
    acc.totals.totalOutputTokens += usage.outputTokens;
    acc.totals.totalCost += usage.cost;
  }
  acc.latestUsage = usage;
  state.totalResponseTimeMs += responseTimeMs;
}

type MonitorContext = ReturnType<typeof createMonitorWithEvents>;

function createMonitorWithEvents() {
  const logger = new TraceEmitter();
  const runId = 'usage-last-totals' as RunId;
  const recorded = recordTraceEvents(logger);
  const monitor = new UsageMonitor(
    { logger, runId, runStageId: undefined },
    { agentName: 'assistant', agentCategory: AgentCategory.ToolUse },
  );
  return {
    monitor,
    logger,
    events: recorded.events,
    dispose: () => {},
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
      await monitor.recordUsage(state, testModelInfo);

      // The cache holds the exact totals object the accumulator exposed, so a
      // failed run's terminal `result` event can report usage from the catch arm.
      expect(monitor.lastTotals()).toBe(state.usageAccumulator.totals);
    });
  });

  it('forwards the ChatGPT subscription route to session usage facts', async () => {
    await withMonitor(async ({ monitor, events }) => {
      const state = AgentRunStateSnapshotSchema.parse({});
      recordRound(state, 50, {
        inputTokens: 10,
        outputTokens: 2,
        cost: 0,
        responseTimeMs: 50,
        provider: 'openai-responses',
        usageRoute: 'chatgpt-subscription',
      });

      await monitor.recordUsage(state, testModelInfo);

      const usageEvent = traceEventsOfType(events, 'usage').at(0);
      expect(usageEvent).toMatchObject({
        usage: {
          usageRoute: 'chatgpt-subscription',
        },
      });
      expect(usageEvent?.usage).not.toHaveProperty('viaChatGptSubscription');
    });
  });

  it('publishes the run total on every usage row while billing the round', async () => {
    await withMonitor(async ({ monitor, events }) => {
      const log = vi.spyOn(UsageLogService, 'log').mockImplementation(() => {});
      const state = AgentRunStateSnapshotSchema.parse({});
      const round = {
        inputTokens: 100,
        outputTokens: 10,
        cost: 0.01,
        responseTimeMs: 50,
        provider: 'openai-chat' as const,
      };
      recordRound(state, 50, round);
      await monitor.recordUsage(state, testModelInfo);
      recordRound(state, 50, round);
      await monitor.recordUsage(state, testModelInfo);

      // The session row is a snapshot of the run's spend (the fold replaces
      // the run's total with the newest row), so the second round's row
      // carries both rounds.
      const rows = traceEventsOfType(events, 'usage');
      expect(rows.map((row) => row.usage.inputTokens)).toEqual([100, 200]);
      expect(rows.map((row) => row.usage.outputTokens)).toEqual([10, 20]);
      expect(rows.map((row) => row.usage.cost)).toEqual([0.01, 0.02]);

      // Backend billing stays per round: two calls, one round each.
      expect(log).toHaveBeenCalledTimes(2);
      for (const call of log.mock.calls) {
        expect(call[0]).toMatchObject({ inputTokens: 100, outputTokens: 10 });
      }
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
        provider: 'openai-chat' as const,
      };
      recordRound(state, 50, usage);
      await monitor.recordUsage(state, testModelInfo);

      recordRound(state, 25, null);
      expect(state.usageAccumulator.latestUsage).toBeNull();
      await monitor.recordUsage(state, testModelInfo);

      expect(traceEventsOfType(events, 'usage')).toHaveLength(1);
      expect(log).toHaveBeenCalledTimes(1);
      expect(monitor.lastTotals()).toBe(state.usageAccumulator.totals);
      expect(state.usageAccumulator.totals).toMatchObject({
        totalInputTokens: 10,
        totalOutputTokens: 2,
      });
    });
  });

  it('bills a round against the model the run switched to', async () => {
    await withMonitor(async ({ monitor }) => {
      const log = vi.spyOn(UsageLogService, 'log').mockImplementation(() => {});
      const switched = {
        config: { ...testModelInfo.config, fullName: 'Switched Model' },
      };

      const state = AgentRunStateSnapshotSchema.parse({});
      recordRound(state, 50, {
        inputTokens: 10,
        outputTokens: 2,
        cost: 0.01,
        responseTimeMs: 50,
        provider: 'openai-chat' as const,
      });
      await monitor.recordUsage(state, switched);

      // The loop passes the binding that served the round, so the round is
      // billed against it and not against the launch model.
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'Switched Model' }),
      );
    });
  });

  it('uses the normalized provider for backend usage accounting', async () => {
    await withMonitor(async ({ logger, monitor }) => {
      const warn = vi.spyOn(logger, 'warn');
      const log = vi.spyOn(UsageLogService, 'log').mockImplementation(() => {});
      const other = {
        config: { ...testModelInfo.config, provider: ModelProvider.OTHERS },
      };
      const state = AgentRunStateSnapshotSchema.parse({});
      recordRound(state, 50, {
        inputTokens: 10,
        outputTokens: 2,
        cost: 0.01,
        responseTimeMs: 50,
        provider: 'openrouter-chat' as const,
      });

      await monitor.recordUsage(state, other);

      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'openrouter-chat' }),
      );
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
