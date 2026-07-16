import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setupPlatform } from '@test/support/setupPlatform';
import { clearStoreCache, getExecutionStore } from '@agent/storage';
import {
  readWorkflowScriptCheckpoint,
  runPersistedWorkflowScript,
  type WorkflowJournalEntry,
} from '@agent/workflowScript';
import { RUN_OUTCOME, type ExecutionId } from '@shared/schemas';
import {
  sumCompletedWorkflowJournalCost,
  workflowJournalEntryCostIdentity,
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
  return { index, key: entryKey, result };
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

beforeEach(() => clearStoreCache());

describe('workflow-script completed journal cost', () => {
  it('sums canonical workflow and tool-use results independent of entry order', () => {
    const journal = [
      entry(4, toolUseResult(0.25)),
      entry(1, workflowResult(1.5)),
    ];

    expect(sumCompletedWorkflowJournalCost(journal)).toBe(1.75);
    expect(sumCompletedWorkflowJournalCost(journal.toReversed())).toBe(1.75);
  });

  it('uses the final-result default when an older entry omits cost', () => {
    const result = workflowResult(0) as Record<string, unknown>;
    delete result.cost;

    expect(sumCompletedWorkflowJournalCost([entry(0, result)])).toBe(0);
  });

  it('charges a live replacement but not stable recoveries moved to new indices', () => {
    const priorA = entry(2, workflowResult(1), 'aaaaaaaaaaaaaaaa');
    const priorB = entry(3, workflowResult(0.8), 'bbbbbbbbbbbbbbbb');
    const priorReplaced = entry(4, workflowResult(0.6), 'dddddddddddddddd');
    const recoveredAfterReorder = [
      entry(priorA.index, priorB.result, priorB.key),
      entry(priorB.index, priorA.result, priorA.key),
    ];
    const liveReplacement = entry(
      priorReplaced.index,
      workflowResult(0.45),
      'cccccccccccccccc',
    );
    const retry = [...recoveredAfterReorder, liveReplacement];

    expect(
      sumCompletedWorkflowJournalCost(
        retry,
        new Set([workflowJournalEntryCostIdentity(liveReplacement)]),
      ),
    ).toBe(0.45);
  });

  it.each([
    ['wrong result shape', entry(3, { cost: 1 })],
    ['negative cost', entry(7, workflowResult(-1))],
  ])('rejects %s with the journal index', (_label, invalidEntry) => {
    expect(() => sumCompletedWorkflowJournalCost([invalidEntry])).toThrow(
      WorkflowJournalCostError,
    );
    expect(() => sumCompletedWorkflowJournalCost([invalidEntry])).toThrow(
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
    expect(sumCompletedWorkflowJournalCost(first.journal)).toBe(1);
    expect(sumCompletedWorkflowJournalCost(replayed.journal)).toBe(1);
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
    expect(sumCompletedWorkflowJournalCost(checkpoint?.journal ?? [])).toBe(
      0.75,
    );
  });
});
