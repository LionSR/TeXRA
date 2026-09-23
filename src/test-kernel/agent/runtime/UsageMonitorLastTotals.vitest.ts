import { ModelProvider } from 'llm-zoo';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TraceEmitter } from '@agent/trace';
import { UsageMonitor } from '@agent/runtime/UsageMonitor';
import {
  AgentCategory,
  RunUsageTotalsSchema,
  type NormalizedUsage,
  type RunId,
  type RunUsageTotals,
} from '@shared/schemas';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';

// Local file imports
import { recordTraceEvents, traceEventsOfType } from '../progressTestUtils';
import { testModelInfo } from '../runtime/launchContextTestUtils';

// One restore after each test covers every vi.spyOn in this file.
afterEach(() => {
  vi.restoreAllMocks();
});

/** What the loop hands the monitor: the run's folded totals and the
 *  round's own priced usage. */
interface RunUsage {
  readonly totals: RunUsageTotals;
  latestUsage: NormalizedUsage | null;
}

const freshUsage = (): RunUsage => ({
  totals: RunUsageTotalsSchema.parse({}),
  latestUsage: null,
});

/**
 * One round's usage folded into the totals the monitor reads, the way the
 * ledger's fold sums `response.usage` rows: totals accumulate, `latestUsage`
 * is the round's own figure (null for a usage-less continuation).
 */
function recordRound(state: RunUsage, usage: NormalizedUsage | null): void {
  const { totals } = state;
  if (usage) {
    if (totals.firstInputTokens === 0) {
      totals.firstInputTokens = usage.inputTokens;
    }
    totals.totalInputTokens += usage.inputTokens;
    totals.totalOutputTokens += usage.outputTokens;
    totals.totalCost += usage.cost;
    totals.totalResponseTimeMs += usage.responseTimeMs;
  }
  state.latestUsage = usage;
}

type MonitorContext = ReturnType<typeof createMonitorWithEvents>;

function createMonitorWithEvents() {
  const logger = new TraceEmitter();
  const runId = 'usage-last-totals' as RunId;
  const recorded = recordTraceEvents(logger);
  const log = vi.fn();
  const monitor = new UsageMonitor(
    {
      logger,
      runId,
      runStageId: undefined,
      config: testWorkspaceRoots().config,
      usageLog: { log },
    },
    { agentName: 'assistant', agentCategory: AgentCategory.ToolUse },
  );
  return {
    monitor,
    logger,
    log,
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

      const state = freshUsage();
      monitor.recordUsage(state.totals, state.latestUsage, testModelInfo);

      // The cache holds the exact totals object the accumulator exposed, so a
      // failed run's terminal `result` event can report usage from the catch arm.
      expect(monitor.lastTotals()).toBe(state.totals);
    });
  });

  it('forwards the ChatGPT subscription route to session usage facts', async () => {
    await withMonitor(async ({ monitor, events }) => {
      const state = freshUsage();
      recordRound(state, {
        inputTokens: 10,
        outputTokens: 2,
        cost: 0,
        responseTimeMs: 50,
        provider: 'openai-responses',
        usageRoute: 'chatgpt-subscription',
      });

      monitor.recordUsage(state.totals, state.latestUsage, testModelInfo);

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
    await withMonitor(async ({ monitor, events, log }) => {
      const state = freshUsage();
      const round = {
        inputTokens: 100,
        outputTokens: 10,
        cost: 0.01,
        responseTimeMs: 50,
        provider: 'openai-chat' as const,
      };
      recordRound(state, round);
      monitor.recordUsage(state.totals, state.latestUsage, testModelInfo);
      recordRound(state, round);
      monitor.recordUsage(state.totals, state.latestUsage, testModelInfo);

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
    await withMonitor(async ({ monitor, events, log }) => {
      const state = freshUsage();
      const usage = {
        inputTokens: 10,
        outputTokens: 2,
        cost: 0.01,
        responseTimeMs: 50,
        provider: 'openai-chat' as const,
      };
      recordRound(state, usage);
      monitor.recordUsage(state.totals, state.latestUsage, testModelInfo);

      recordRound(state, null);
      expect(state.latestUsage).toBeNull();
      monitor.recordUsage(state.totals, state.latestUsage, testModelInfo);

      expect(traceEventsOfType(events, 'usage')).toHaveLength(1);
      expect(log).toHaveBeenCalledTimes(1);
      expect(monitor.lastTotals()).toBe(state.totals);
      expect(state.totals).toMatchObject({
        totalInputTokens: 10,
        totalOutputTokens: 2,
      });
    });
  });

  it('bills a round against the model the run switched to', async () => {
    await withMonitor(async ({ monitor, log }) => {
      const switched = {
        config: { ...testModelInfo.config, fullName: 'Switched Model' },
      };

      const state = freshUsage();
      recordRound(state, {
        inputTokens: 10,
        outputTokens: 2,
        cost: 0.01,
        responseTimeMs: 50,
        provider: 'openai-chat' as const,
      });
      monitor.recordUsage(state.totals, state.latestUsage, switched);

      // The loop passes the binding that served the round, so the round is
      // billed against it and not against the launch model.
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'Switched Model' }),
        expect.anything(),
      );
    });
  });

  it('uses the normalized provider for backend usage accounting', async () => {
    await withMonitor(async ({ logger, monitor, log }) => {
      const warn = vi.spyOn(logger, 'warn');
      const other = {
        config: { ...testModelInfo.config, provider: ModelProvider.OTHERS },
      };
      const state = freshUsage();
      recordRound(state, {
        inputTokens: 10,
        outputTokens: 2,
        cost: 0.01,
        responseTimeMs: 50,
        provider: 'openrouter-chat' as const,
      });

      monitor.recordUsage(state.totals, state.latestUsage, other);

      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'openrouter-chat' }),
        expect.anything(),
      );
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
