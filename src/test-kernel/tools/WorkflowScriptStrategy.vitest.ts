import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setupPlatform } from '@test/support/setupPlatform';
import { createTestSession } from '@test/support/sessionTestUtils';
import { clearStoreCache, getExecutionStore } from '@agent/storage';
import { TraceEmitter } from '@agent/trace';
import {
  deriveWorkflowScriptCheckpointId,
  runPersistedWorkflowScript,
  WORKFLOW_SKIPPED_RESULT,
  type WorkflowAgentInvocation,
  type WorkflowAgentRunner,
} from '@agent/workflowScript';
import type { AgentFinalResult } from '@agent/runtime/AgentFinalResult';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
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
function billingRunAgent(hooks: {
  onCost: (i: WorkflowAgentInvocation, c: number | undefined) => void;
}): WorkflowAgentRunner {
  return async (invocation) => {
    hooks.onCost(invocation, finalResult.cost);
    return finalResult;
  };
}

function fakePorts() {
  return { notify: vi.fn(), recordCost: vi.fn() };
}

let session: SessionHandle;

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
    session,
    ...overrides,
  };
}

beforeEach(() => {
  clearStoreCache();
  session = createTestSession();
});

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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A fake `runAgent` that stands in for the production runner: it announces its
 * grandchild execution id through the `onChildActive` bridge and hangs the
 * first attempt until the per-call signal aborts, so a test can drive an
 * interactive skip/retry against a call that is genuinely in flight.
 */
function controllableRunAgent(grandchildExecutionId: ExecutionId): {
  readonly createRunAgent: WorkflowScriptStrategyParams['createRunAgent'];
  readonly firstAttemptStarted: Promise<void>;
  readonly attempts: () => number;
  readonly onCost: (cost: number) => void;
} {
  const started = deferred();
  let attemptCount = 0;
  let reportCost: ((cost: number) => void) | undefined;
  const createRunAgent: WorkflowScriptStrategyParams['createRunAgent'] = (
    hooks,
  ) => {
    return async (invocation) => {
      attemptCount += 1;
      const thisAttempt = attemptCount;
      reportCost = (cost) => hooks.onCost(invocation, cost);
      hooks.onChildActive(grandchildExecutionId, invocation, true);
      started.resolve();
      try {
        if (thisAttempt === 1) {
          // Hang until a control action aborts this attempt (skip/retry).
          await new Promise<never>((_, reject) => {
            invocation.signal.addEventListener(
              'abort',
              () => reject(invocation.signal.reason),
              { once: true },
            );
          });
        }
        return finalResult;
      } finally {
        hooks.onChildActive(grandchildExecutionId, invocation, false);
      }
    };
  };
  return {
    createRunAgent,
    firstAttemptStarted: started.promise,
    attempts: () => attemptCount,
    onCost: (cost) => reportCost?.(cost),
  };
}

describe('createWorkflowScriptStrategy interactive controls', () => {
  const grandchildExecutionId = 'grandchild-exec-0' as ExecutionId;

  it('skips an in-flight grandchild by execution id via the session registry', async () => {
    const fake = controllableRunAgent(grandchildExecutionId);
    const strategy = createWorkflowScriptStrategy(
      strategyParams({
        name: 'strategy-test',
        createRunAgent: fake.createRunAgent,
      }),
    );

    const launch = strategy.launch(fakePorts(), new AbortController());
    await fake.firstAttemptStarted;
    // An unknown execution id no-ops (the call stays in flight)...
    session.workflowControls.skip('not-a-grandchild' as ExecutionId);
    // ...while the right one translates execId → index → engine skip.
    session.workflowControls.skip(grandchildExecutionId);

    const turn = await launch;
    expect(turn.result).toBe(WORKFLOW_SKIPPED_RESULT);
    expect(fake.attempts()).toBe(1);
    // The registration is dropped when the run settles.
    session.workflowControls.skip(grandchildExecutionId);
  });

  it('retries an in-flight grandchild by execution id, re-running the call', async () => {
    const fake = controllableRunAgent(grandchildExecutionId);
    const strategy = createWorkflowScriptStrategy(
      strategyParams({
        name: 'strategy-test',
        createRunAgent: fake.createRunAgent,
      }),
    );

    const launch = strategy.launch(fakePorts(), new AbortController());
    await fake.firstAttemptStarted;
    session.workflowControls.retry(grandchildExecutionId);

    const turn = await launch;
    // The second attempt settles with the real result, and the call ran twice.
    expect(turn.result).toMatchObject({ category: 'workflow', cost: 0.42 });
    expect(fake.attempts()).toBe(2);
  });

  it('bills a skipped attempt that consumed cost to the parent exactly once', async () => {
    const fake = controllableRunAgent(grandchildExecutionId);
    const ports = fakePorts();
    const strategy = createWorkflowScriptStrategy(
      strategyParams({
        name: 'strategy-test',
        createRunAgent: fake.createRunAgent,
      }),
    );

    const launch = strategy.launch(ports, new AbortController());
    await fake.firstAttemptStarted;
    // Model tokens were spent before the user skipped the attempt.
    fake.onCost(0.42);
    session.workflowControls.skip(grandchildExecutionId);

    const turn = await launch;
    expect(turn.result).toBe(WORKFLOW_SKIPPED_RESULT);
    // The discarded attempt is billed once even though it was never journaled.
    expect(ports.recordCost).toHaveBeenCalledTimes(1);
    expect(ports.recordCost).toHaveBeenCalledWith(0.42);
  });
});
