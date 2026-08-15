import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearStoreCache, getExecutionStore } from '@agent/storage';
import {
  readWorkflowScriptCheckpoint,
  runPersistedWorkflowScript,
  runWorkflowScript,
  type WorkflowJournalEntry,
  type WorkflowScriptControl,
} from '@agent/workflowScript';
import { RUN_OUTCOME, type ExecutionId } from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  createWorkflowAttemptCostTracker,
  WorkflowJournalCostError,
} from '@tools/delegation/workflowScriptRun';

const executionId = '7154costtest' as ExecutionId;
const key = '0000000000000000';
const meta = `export const meta = {
  name: 'cost-test',
  description: 'tests completed workflow journal costs',
}`;

setupPlatform({ storagePath: '/storage', workspacePath: '/workspace' });

function entry(
  index: number,
  result: unknown,
  entryKey = key,
): WorkflowJournalEntry {
  return {
    index,
    key: entryKey,
    result,
  };
}

function workflowResult(cost: number): unknown {
  return {
    category: 'workflow',
    outcome: RUN_OUTCOME.COMPLETED,
    outputs: [],
    compileFailures: [],
    diffs: [],
    cost,
  };
}

function toolUseResult(cost: number): unknown {
  return {
    category: 'toolUse',
    outcome: RUN_OUTCOME.COMPLETED,
    response: 'done',
    files: [],
    cost,
  };
}

/**
 * Settle a journal's completed cost through the public tracker surface: one
 * zero-cost attempt per entry makes `total` charge each entry's validated
 * final-result cost (`max(0, journalCost)`), i.e. the sum of journal costs.
 */
function settleJournalCost(journal: readonly WorkflowJournalEntry[]): number {
  const tracker = createWorkflowAttemptCostTracker();
  for (const journalEntry of journal) tracker.record(journalEntry, 0);
  return tracker.total(journal);
}

beforeEach(() => clearStoreCache());

describe('workflow attempt cost', () => {
  it('aggregates observability cost across physical interactive attempts', async () => {
    let control!: WorkflowScriptControl;
    let attempt = 0;
    const run = runWorkflowScript({
      script: `${meta}
return await agent('retry cost')`,
      runAgent: async (invocation) => {
        attempt += 1;
        invocation.report?.({
          costUsd: attempt === 1 ? 0.2 : 0.3,
          childExecutionId: `retry-cost-${attempt}` as ExecutionId,
        });
        if (attempt === 1) {
          await new Promise<void>((_resolve, reject) =>
            invocation.signal.addEventListener(
              'abort',
              () => reject(new Error('retrying')),
              { once: true },
            ),
          );
        }
        return 'done';
      },
      onControl: (value) => {
        control = value;
      },
    });

    await vi.waitFor(() => expect(attempt).toBe(1));
    control('retry-cost-1' as ExecutionId, 'retry');
    await vi.waitFor(() => expect(attempt).toBe(2));
    const result = await run;

    expect(result.snapshot.calls[0]?.attempts).toMatchObject([
      { number: 1, costUsd: 0.2 },
      { number: 2, costUsd: 0.3 },
    ]);
    expect(result.snapshot.calls[0]?.costUsd).toBeCloseTo(0.5);
  });

  it('adds discarded retry cost before an undefined final observer fallback', () => {
    const completed = entry(0, workflowResult(0.5), 'completed');
    const tracker = createWorkflowAttemptCostTracker();

    expect(tracker.record(completed, 0.1)).toBe(0.1);
    // Production normalizes the final attempt's undefined callback to zero.
    expect(tracker.record(completed, 0)).toBe(0.1);
    expect(tracker.record({ index: 1, key: 'skipped' }, 0.2)).toBeCloseTo(0.3);
    expect(tracker.record({ index: 2, key: 'failed' }, 0.15)).toBeCloseTo(0.45);
    expect(tracker.total([completed])).toBeCloseTo(0.95);
  });

  it('adds discarded retry cost before a lower final observer fallback', () => {
    const completed = entry(0, workflowResult(0.5), 'completed');
    const tracker = createWorkflowAttemptCostTracker();

    tracker.record(completed, 0.1);
    tracker.record(completed, 0.2);
    expect(tracker.total([completed])).toBeCloseTo(0.6);
  });

  it('reports invocation-cumulative totals compatible with the loop max-latch', () => {
    // ChildRunPorts contract: the loop retains max(best observation), which is
    // only correct over cumulative observations — record() must return a
    // running invocation total that never decreases, whatever the attempt
    // interleaving.
    const tracker = createWorkflowAttemptCostTracker();
    const observations = [
      tracker.record({ index: 0, key: 'a' }, 0.2),
      tracker.record({ index: 1, key: 'b' }, 0.1),
      tracker.record({ index: 0, key: 'a' }, 0),
      tracker.record({ index: 2, key: 'c' }, 0.3),
    ];
    for (let i = 1; i < observations.length; i += 1) {
      expect(observations[i]).toBeGreaterThanOrEqual(observations[i - 1] ?? 0);
    }
    expect(observations.at(-1)).toBeCloseTo(0.6);
  });

  it('terminal settlement never undercuts the live-observed total', () => {
    // The journal fallback only raises a completed key's final attempt, so
    // total() >= the last live record(); under the loop's max-latch the
    // committed value is therefore the terminal total, and a cheap journal
    // can never shrink already-observed spend.
    const cheapJournal = entry(0, workflowResult(0.05), 'live');
    const tracker = createWorkflowAttemptCostTracker();

    tracker.record(cheapJournal, 0.1);
    const live = tracker.record(cheapJournal, 0.4);
    expect(tracker.total([cheapJournal])).toBeGreaterThanOrEqual(live);
    expect(tracker.total([cheapJournal])).toBeCloseTo(0.5);
  });

  it('separates sequential duplicate keys when only the first call is live', () => {
    const live = entry(0, workflowResult(0.4), 'duplicate');
    const recovered = entry(1, workflowResult(0.7), 'duplicate');
    const tracker = createWorkflowAttemptCostTracker();

    tracker.record(live, 0.4);
    expect(tracker.total([live, recovered])).toBe(0.4);
  });

  it('separates parallel duplicate keys when only one call retries', () => {
    const retried = entry(0, workflowResult(0.5), 'duplicate');
    const singleAttempt = entry(1, workflowResult(0.4), 'duplicate');
    const tracker = createWorkflowAttemptCostTracker();

    // Interleaved callback order models parallel calls. Only index 0 retries.
    tracker.record(retried, 0.1);
    tracker.record(singleAttempt, 0.4);
    tracker.record(retried, 0);
    expect(tracker.total([retried, singleAttempt])).toBeCloseTo(1);
  });

  it('settles zero for empty-baseline stable recovery with no callback', () => {
    const recovered = entry(0, workflowResult(0.5), 'recovered');
    const tracker = createWorkflowAttemptCostTracker();

    expect(tracker.total([recovered])).toBe(0);
  });

  it('settles zero for replay and stable recovery after reordering', () => {
    const first = entry(0, workflowResult(0.4), 'first');
    const second = entry(1, workflowResult(0.6), 'second');
    const tracker = createWorkflowAttemptCostTracker();

    expect(
      tracker.total([
        entry(0, second.result, second.key),
        entry(1, first.result, first.key),
      ]),
    ).toBe(0);
  });

  it('retains live spend when the final journal is malformed', () => {
    const tracker = createWorkflowAttemptCostTracker();

    expect(tracker.record({ index: 0, key: 'live' }, 0.2)).toBe(0.2);
    expect(() => tracker.total([entry(0, { cost: 1 }, 'live')])).toThrow(
      WorkflowJournalCostError,
    );
  });
});

describe('workflow-script completed journal cost', () => {
  it('sums canonical workflow and tool-use results independent of entry order', () => {
    const journal = [
      entry(4, toolUseResult(0.25)),
      entry(1, workflowResult(1.5)),
    ];

    expect(settleJournalCost(journal)).toBe(1.75);
    expect(settleJournalCost(journal.toReversed())).toBe(1.75);
  });

  it('uses the final-result default when an older entry omits cost', () => {
    const result = workflowResult(0) as Record<string, unknown>;
    delete result.cost;

    expect(settleJournalCost([entry(0, result)])).toBe(0);
  });

  it.each([
    ['wrong result shape', entry(3, { cost: 1 })],
    ['negative cost', entry(7, workflowResult(-1))],
  ])('rejects %s with the journal index', (_label, invalidEntry) => {
    expect(() => settleJournalCost([invalidEntry])).toThrow(
      WorkflowJournalCostError,
    );
    expect(() => settleJournalCost([invalidEntry])).toThrow(
      new RegExp(`entry ${invalidEntry.index}`),
    );
  });

  it('produces the same total after a checkpoint replay', async () => {
    const store = getExecutionStore(executionId);
    const script = `${meta}
await agent('first')
return await agent('second')`;
    const results = [workflowResult(0.4), toolUseResult(0.6)];
    const first = await runPersistedWorkflowScript({
      store,
      checkpointId: 'replay',
      script,
      runAgent: async ({ index }) => results[index],
    });

    clearStoreCache();
    const runner = vi.fn(() => Promise.reject(new Error('must replay')));
    const replayed = await runPersistedWorkflowScript({
      store: getExecutionStore(executionId),
      checkpointId: 'replay',
      runAgent: runner,
    });

    expect(runner).not.toHaveBeenCalled();
    expect(settleJournalCost(first.journal)).toBe(1);
    expect(settleJournalCost(replayed.journal)).toBe(1);
  });

  it('can settle completed entries retained after a script failure', async () => {
    const store = getExecutionStore(executionId);
    const script = `${meta}
await agent('completed')
throw new Error('later failure')`;

    await expect(
      runPersistedWorkflowScript({
        store,
        checkpointId: 'failure',
        script,
        runAgent: async () => workflowResult(0.75),
      }),
    ).rejects.toThrow('later failure');

    const checkpoint = await readWorkflowScriptCheckpoint(store, 'failure');
    expect(settleJournalCost(checkpoint?.journal ?? [])).toBe(0.75);
  });
});
