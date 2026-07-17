import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setupPlatform } from '@test/support/setupPlatform';
import { clearStoreCache, getExecutionStore } from '@agent/storage';
import { TraceEmitter } from '@agent/trace';
import {
  deriveWorkflowScriptCheckpointId,
  runPersistedWorkflowScript,
  type WorkflowAgentInvocation,
  type WorkflowAgentRunner,
} from '@agent/workflowScript';
import type { AgentFinalResult } from '@agent/runtime/AgentFinalResult';
import type { ExecutionId } from '@shared/schemas';
import {
  createWorkflowScriptStrategy,
  type WorkflowScriptStrategyParams,
} from '@tools/delegation/workflowScriptStrategy';

setupPlatform({ storagePath: '/storage', workspacePath: '/workspace' });

const executionId = '7154strategy' as ExecutionId;
const script = `export const meta = {
  name: 'strategy-test',
  description: 'tests the workflow script strategy',
}
return await agent('saved call')`;
const finalResult: AgentFinalResult = {
  category: 'workflow',
  outcome: 'completed',
  outputs: [],
  compileFailures: [],
  diffs: [],
  cost: 0.42,
};

function checkpointIdFor(name: string): string {
  return deriveWorkflowScriptCheckpointId({
    name,
    defaultAgent: 'correct',
    parentExecutionId: executionId,
  });
}

/** A runAgent that reports its cost through the strategy's onCost hook. */
function billingRunAgent(
  hooks: {
    onCost: (i: WorkflowAgentInvocation, c: number | undefined) => void;
  },
  result: unknown = finalResult,
): WorkflowAgentRunner {
  return async (invocation) => {
    hooks.onCost(invocation, finalResult.cost);
    return result as AgentFinalResult;
  };
}

function fakePorts() {
  return { notify: vi.fn(), recordCost: vi.fn() };
}

function strategyParams(
  overrides: Partial<WorkflowScriptStrategyParams> & {
    readonly name: string;
    readonly createRunAgent: WorkflowScriptStrategyParams['createRunAgent'];
  },
): WorkflowScriptStrategyParams {
  return {
    executionId,
    logger: new TraceEmitter(),
    store: getExecutionStore(executionId),
    checkpointId: checkpointIdFor(overrides.name),
    script,
    args: undefined,
    ...overrides,
  };
}

beforeEach(() => clearStoreCache());

describe('createWorkflowScriptStrategy', () => {
  it('is a terminal-only strategy with no runTurn', () => {
    const strategy = createWorkflowScriptStrategy(
      strategyParams({
        name: 'strategy-test',
        createRunAgent: (hooks) => billingRunAgent(hooks),
      }),
    );
    expect(strategy.isTerminal({} as never)).toBe(true);
    expect(strategy.runTurn).toBeUndefined();
    expect(strategy.stageLabel).toBe("Workflow script 'strategy-test'");
  });

  it('runs a live call, settles its journal cost, and delivers the result', async () => {
    const ports = fakePorts();
    const strategy = createWorkflowScriptStrategy(
      strategyParams({
        name: 'strategy-test',
        createRunAgent: (hooks) => billingRunAgent(hooks),
      }),
    );

    const turn = await strategy.launch(ports, new AbortController());

    // Journal-based settlement of the one live call.
    expect(ports.recordCost).toHaveBeenCalledTimes(1);
    expect(ports.recordCost).toHaveBeenCalledWith(0.42);

    const delivery = await strategy.formatDelivery(turn, 0);
    expect(delivery).toContain('"category": "workflow"');
    // The run log rides along so the invoking model sees what executed.
    expect(delivery).toContain('=== Run log ===');
    expect(delivery).toContain('Finished');
  });

  it('replays a named checkpoint and settles zero for a pure resume', async () => {
    await runPersistedWorkflowScript({
      store: getExecutionStore(executionId),
      checkpointId: checkpointIdFor('strategy-test'),
      script,
      runAgent: async () => finalResult,
    });
    clearStoreCache();
    const ports = fakePorts();
    const strategy = createWorkflowScriptStrategy(
      strategyParams({
        name: 'strategy-test',
        // A retrying model rewrites its source; same meta.name still resumes.
        script: `${script}\n// retry rewrote me`,
        createRunAgent: () => async () => {
          throw new Error('replayed call must not re-execute');
        },
      }),
    );

    const turn = await strategy.launch(ports, new AbortController());

    // Delta accounting: replayed entries were billed by the executing attempt.
    expect(ports.recordCost).toHaveBeenCalledWith(0);
    const delivery = await strategy.formatDelivery(turn, 0);
    expect(delivery).toContain('Using saved result');
  });

  it('passes JSON arguments through and formats a zero-call result', async () => {
    const ports = fakePorts();
    const strategy = createWorkflowScriptStrategy(
      strategyParams({
        name: 'arguments',
        script: `export const meta = {
  name: 'arguments',
  description: 'returns its arguments',
}
return args`,
        args: { question: 'What is conserved?' },
        createRunAgent: (hooks) => billingRunAgent(hooks),
      }),
    );

    const turn = await strategy.launch(ports, new AbortController());
    const delivery = await strategy.formatDelivery(turn, 0);
    expect(delivery).toContain('"question": "What is conserved?"');
    expect(ports.recordCost).toHaveBeenCalledWith(0);
  });

  it('retains checkpoint arguments when a null retry omits them', async () => {
    const argsScript = `export const meta = {
  name: 'retained-arguments',
  description: 'retains omitted retry arguments',
}
return args`;
    await runPersistedWorkflowScript({
      store: getExecutionStore(executionId),
      checkpointId: checkpointIdFor('retained-arguments'),
      script: argsScript,
      args: { topic: 'geometry' },
      runAgent: async () => finalResult,
    });
    clearStoreCache();
    const strategy = createWorkflowScriptStrategy(
      strategyParams({
        name: 'retained-arguments',
        script: `${argsScript}\n// revised retry`,
        args: null,
        createRunAgent: (hooks) => billingRunAgent(hooks),
      }),
    );

    const turn = await strategy.launch(fakePorts(), new AbortController());
    const delivery = await strategy.formatDelivery(turn, 0);
    expect(delivery).toContain('"topic": "geometry"');
  });

  it('bounds and normalizes the model-visible run log', async () => {
    const strategy = createWorkflowScriptStrategy(
      strategyParams({
        name: 'bounded-log',
        script: `export const meta = {
  name: 'bounded-log',
  description: 'bounds model-visible activity',
}
for (let index = 0; index < 100; index += 1) log('line-' + index)
log('oversized\\n' + 'x'.repeat(2_000))
return 'done'`,
        createRunAgent: (hooks) => billingRunAgent(hooks),
      }),
    );

    const turn = await strategy.launch(fakePorts(), new AbortController());
    const delivery = await strategy.formatDelivery(turn, 0);
    expect(delivery).toContain(
      '=== Run log (last 80 lines; 21 earlier lines omitted) ===',
    );
    expect(delivery).not.toContain('line-20\n');
    expect(delivery).toContain('line-21\n');
    expect(delivery).toContain('oversized x');
    expect(delivery.length).toBeLessThan(42_000);
  });

  it('settles a retained journal and surfaces the resume hint when script code fails', async () => {
    const failingScript = `export const meta = {
  name: 'retained-settlement',
  description: 'tests retained journal settlement',
}
await agent('saved call')
throw new Error('script failed after replay')`;
    await expect(
      runPersistedWorkflowScript({
        store: getExecutionStore(executionId),
        checkpointId: checkpointIdFor('retained-settlement'),
        script: failingScript,
        runAgent: async () => finalResult,
      }),
    ).rejects.toThrow('script failed after replay');
    clearStoreCache();
    const ports = fakePorts();
    const strategy = createWorkflowScriptStrategy(
      strategyParams({
        name: 'retained-settlement',
        script: failingScript,
        createRunAgent: () => async () => {
          throw new Error('replayed call must not re-execute');
        },
      }),
    );

    await expect(strategy.launch(ports, new AbortController())).rejects.toThrow(
      'script failed after replay',
    );
    // The seeding attempt billed the entry; this attempt only replays it.
    expect(ports.recordCost).toHaveBeenCalledWith(0);

    const errText = await strategy.formatError(null, new Error('boom'));
    expect(errText).toContain(
      "journaled under meta.name 'retained-settlement'",
    );
    expect(errText).toContain('boom');
  });

  it('fails closed on a malformed journal cost without recording a scalar', async () => {
    const malformedScript = `export const meta = {
  name: 'malformed-cost',
  description: 'tests malformed journal cost settlement',
}
return await agent('saved call')`;
    await runPersistedWorkflowScript({
      store: getExecutionStore(executionId),
      checkpointId: checkpointIdFor('malformed-cost'),
      script: malformedScript,
      runAgent: async () => ({ not: 'an agent result' }),
    });
    clearStoreCache();
    const ports = fakePorts();
    const strategy = createWorkflowScriptStrategy(
      strategyParams({
        name: 'malformed-cost',
        script: malformedScript,
        createRunAgent: () => async () => finalResult,
      }),
    );

    await expect(strategy.launch(ports, new AbortController())).rejects.toThrow(
      'Workflow journal entry 0 is not an agent final result',
    );
    expect(ports.recordCost).not.toHaveBeenCalled();
  });
});
