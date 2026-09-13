import '@test/support/defaultSessionTestSetup';
import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { beforeAll, beforeEach, describe, expect, vi } from 'vitest';

import { TraceEmitter } from '@agent/trace';
import { deriveWorkflowScriptCheckpointId } from '@agent/workflowScript/checkpoint';
import { runPersistedWorkflowScript } from '@agent/workflowScript/checkpoint';
import type { WorkflowAgentInvocation } from '@agent/workflowScript/types';
import { currentSession } from '@agent/runtime/SessionHandle';
import { WORKFLOW_SKIPPED_RESULT } from '@agent/workflowScript/types';
import { WorkflowControlRegistry } from '@agent/runtime/workflowControlRegistry';
import {
  RunUsageTotalsSchema,
  type OutputFileSummary,
  type RunEnd,
  type RunId,
} from '@shared/schemas';
import { createDeferred } from '@test/support/asyncTestUtils';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { setupPlatform } from '@test/support/setupPlatform';
import { fingerprintWorkflowAgentDependencies } from '@tools/delegation/inputFields';
import {
  createWorkflowScriptStrategy,
  type WorkflowScriptStrategyParams,
} from '@tools/delegation/workflowScriptStrategy';

setupPlatform({ storagePath: '/storage', workspacePath: '/workspace' });

const runId = '7154decade01' as RunId;
const script = `export const meta = {
  name: 'strategy-test',
  description: 'tests the workflow script strategy',
}
return await agent('saved call')`;
const paperOutput: OutputFileSummary = {
  round: 0,
  relativePath: 'paper.tex',
  absolutePath: '/workspace/paper.tex',
  location: 'workspace',
  originalPath: '/workspace/paper.tex',
  added: 12,
  removed: 8,
};
const finalResult: RunEnd = {
  outcome: 'completed',
  usage: RunUsageTotalsSchema.parse({ totalCost: 0.42 }),
  output: {
    category: 'workflow',
    outputs: [paperOutput],
    compileFailures: [],
    diffs: [],
  },
};

/**
 * A checkpoint id of this test's own. The journal lives on the session's
 * `workflow-checkpoint` aggregate, which outlives one test, so two tests
 * sharing a `meta.name` under one parent would otherwise share a journal and
 * replay each other's calls.
 */
function checkpointIdFor(name: string): string {
  return deriveWorkflowScriptCheckpointId({
    name: `${name}-${checkpointGeneration}`,
    defaultAgent: 'correct',
    parentRunId: runId,
  });
}

/** A runAgent that reports its cost through the strategy's onCost hook. */
const billingRunAgent: WorkflowScriptStrategyParams['createRunAgent'] =
  (hooks) => (invocation) =>
    Effect.sync(() => {
      hooks.onCost(invocation, finalResult.usage?.totalCost);
      return finalResult;
    });

function fakePorts() {
  return { notify: vi.fn(), recordCost: vi.fn() };
}

let workflowControls: WorkflowControlRegistry;
let checkpointGeneration = 0;

function strategyParams(
  overrides: Partial<WorkflowScriptStrategyParams> & {
    readonly name: string;
    readonly createRunAgent: WorkflowScriptStrategyParams['createRunAgent'];
  },
): WorkflowScriptStrategyParams {
  return {
    runId,
    parentRunId: runId,
    session: currentSession(),
    fingerprintAgentDependencies: (options) =>
      fingerprintWorkflowAgentDependencies(currentSession(), runId, options),
    logger: new TraceEmitter(),
    checkpointId: checkpointIdFor(overrides.name),
    script,
    scriptPath: '.texra/workflow-scripts/draft-strategy.mjs',
    args: undefined,
    workflowControls,
    ...overrides,
  };
}

// The checkpoint aggregate hangs under the run that invoked the workflow, so
// that run has to exist before a script row can name it.
beforeAll(async () => {
  publishTestRunStart(currentSession(), runId);
  await currentSession().settlePublications();
});
function launchStrategy(
  strategy: ReturnType<typeof createWorkflowScriptStrategy>,
  ports = fakePorts(),
  signal = new AbortController().signal,
) {
  return strategy
    .launch(ports, signal)
    .pipe(Effect.provide(nativeToolTestLayer()));
}

beforeEach(() => {
  workflowControls = new WorkflowControlRegistry();
  checkpointGeneration += 1;
});

describe('createWorkflowScriptStrategy', () => {
  it.effect(
    'runs a live call, settles its journal cost, and delivers the result',
    () =>
      Effect.gen(function* () {
        const ports = fakePorts();
        const strategy = createWorkflowScriptStrategy(
          strategyParams({
            name: 'strategy-test',
            createRunAgent: billingRunAgent,
          }),
        );

        const turn = yield* launchStrategy(strategy, ports);

        // The live-attempt candidate and final journal agree on the total.
        expect(ports.recordCost.mock.calls).toEqual([[0.42], [0.42]]);

        const delivery = yield* Effect.promise(() =>
          Promise.resolve(strategy.formatDelivery(turn, 0)),
        );
        expect(delivery).toContain('"category": "workflow"');
        // The run log rides along so the invoking model sees what executed.
        expect(delivery).toContain('=== Run log ===');
        expect(delivery).toContain('Finished');
        expect(delivery).toContain(
          'Script file: .texra/workflow-scripts/draft-strategy.mjs',
        );
        expect(delivery).toContain('with scriptPath:');
        expect(delivery).toContain('<workflow-summary>');
        expect(delivery).toContain('"outcome":"completed"');
        expect(delivery).toContain('"taskDone":1');
        expect(delivery).toContain('"costUsd":0.42');
        expect(delivery).toContain(
          '"files":[{"path":"paper.tex","added":12,"removed":8}]',
        );
      }),
  );

  it.effect(
    'resolves a structured tool-use agent() call to the documented envelope',
    () =>
      Effect.gen(function* () {
        // Regression: #12246 moved the child's result under `RunEnd.output`, and
        // agent() handed scripts the RunEnd itself, so `.structured` read undefined.
        const structuredEnd: RunEnd = {
          outcome: 'completed',
          usage: RunUsageTotalsSchema.parse({ totalCost: 0.1 }),
          output: {
            category: 'toolUse',
            response: 'Solved.',
            files: [],
            structured: { answer: '(±23,±22)' },
          },
        };
        const strategy = createWorkflowScriptStrategy(
          strategyParams({
            name: 'structured-envelope',
            script: `export const meta = {
  name: 'structured-envelope',
  description: 'reads the structured envelope',
}
return await agent('Solve.', {
  agentName: 'prover',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['answer'],
    properties: { answer: { type: 'string' } },
  },
})`,
            createRunAgent: () => () => Effect.succeed(structuredEnd),
          }),
        );

        const turn = yield* launchStrategy(strategy);

        expect(turn.result).toEqual({
          category: 'toolUse',
          outcome: 'completed',
          response: 'Solved.',
          files: [],
          structured: { answer: '(±23,±22)' },
          cost: 0.1,
        });
      }),
  );

  it.effect('settles zero for a pure checkpoint replay', () =>
    Effect.gen(function* () {
      yield* runPersistedWorkflowScript({
        session: currentSession(),
        parentRunId: runId,
        checkpointId: checkpointIdFor('strategy-test'),
        script,
        runAgent: () => Effect.succeed(finalResult),
      });
      const ports = fakePorts();
      const strategy = createWorkflowScriptStrategy(
        strategyParams({
          name: 'strategy-test',
          // A retrying model rewrites its source; same meta.name still resumes.
          script: `${script}\n// retry rewrote me`,
          createRunAgent: () => () =>
            Effect.fail(new Error('replayed call must not re-execute')),
        }),
      );

      const turn = yield* launchStrategy(strategy, ports);

      expect(ports.recordCost).toHaveBeenCalledOnce();
      expect(ports.recordCost).toHaveBeenCalledWith(0);
      const delivery = yield* Effect.promise(() =>
        Promise.resolve(strategy.formatDelivery(turn, 0)),
      );
      expect(delivery).toContain('Using saved result');
      expect(delivery).toContain(
        '"files":[{"path":"paper.tex","added":12,"removed":8}]',
      );
    }),
  );

  it.effect(
    'passes JSON arguments through and formats a zero-call result',
    () =>
      Effect.gen(function* () {
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
            createRunAgent: billingRunAgent,
          }),
        );

        const turn = yield* launchStrategy(strategy, ports);
        const delivery = yield* Effect.promise(() =>
          Promise.resolve(strategy.formatDelivery(turn, 0)),
        );
        expect(delivery).toContain('"question": "What is conserved?"');
        expect(ports.recordCost).toHaveBeenCalledWith(0);
      }),
  );

  it.effect('retains checkpoint arguments when a null retry omits them', () =>
    Effect.gen(function* () {
      const argsScript = `export const meta = {
  name: 'retained-arguments',
  description: 'retains omitted retry arguments',
}
return args`;
      yield* runPersistedWorkflowScript({
        session: currentSession(),
        parentRunId: runId,
        checkpointId: checkpointIdFor('retained-arguments'),
        script: argsScript,
        args: { topic: 'geometry' },
        runAgent: () => Effect.succeed(finalResult),
      });
      const strategy = createWorkflowScriptStrategy(
        strategyParams({
          name: 'retained-arguments',
          script: `${argsScript}\n// revised retry`,
          args: null,
          createRunAgent: billingRunAgent,
        }),
      );

      const turn = yield* launchStrategy(strategy);
      const delivery = yield* Effect.promise(() =>
        Promise.resolve(strategy.formatDelivery(turn, 0)),
      );
      expect(delivery).toContain('"topic": "geometry"');
    }),
  );

  it.effect('bounds and normalizes the model-visible run log', () =>
    Effect.gen(function* () {
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
          createRunAgent: billingRunAgent,
        }),
      );

      const turn = yield* launchStrategy(strategy);
      const delivery = yield* Effect.promise(() =>
        Promise.resolve(strategy.formatDelivery(turn, 0)),
      );
      expect(delivery).toContain(
        '=== Run log (last 80 lines; 21 earlier lines omitted) ===',
      );
      expect(delivery).not.toContain('line-20\n');
      expect(delivery).toContain('line-21\n');
      expect(delivery).toContain('oversized x');
      expect(delivery.length).toBeLessThan(42_000);
    }),
  );

  it.effect(
    'settles a retained journal and surfaces the resume hint when script code fails',
    () =>
      Effect.gen(function* () {
        const failingScript = `export const meta = {
  name: 'retained-settlement',
  description: 'tests retained journal settlement',
}
await agent('saved call')
throw new Error('script failed after replay')`;
        const seedError = yield* Effect.flip(
          runPersistedWorkflowScript({
            session: currentSession(),
            parentRunId: runId,
            checkpointId: checkpointIdFor('retained-settlement'),
            script: failingScript,
            runAgent: () => Effect.succeed(finalResult),
          }),
        );
        expect(seedError.message).toContain('script failed after replay');
        const ports = fakePorts();
        const strategy = createWorkflowScriptStrategy(
          strategyParams({
            name: 'retained-settlement',
            script: failingScript,
            createRunAgent: () => () =>
              Effect.fail(new Error('replayed call must not re-execute')),
          }),
        );

        const launchError = yield* Effect.flip(launchStrategy(strategy, ports));
        expect(launchError.message).toContain('script failed after replay');
        // Failure recovery excludes the pre-run journal from this invocation.
        expect(ports.recordCost).toHaveBeenCalledWith(0);

        const errText = yield* Effect.promise(() =>
          Promise.resolve(strategy.formatError(null, new Error('boom'))),
        );
        expect(errText).toContain(
          "journaled under meta.name 'retained-settlement'",
        );
        expect(errText).toContain('boom');
        expect(errText).toContain(
          'Script file: .texra/workflow-scripts/draft-strategy.mjs',
        );
        expect(errText).toContain('with scriptPath:');
        expect(errText).toContain('"outcome":"failed"');
        // The failure line's tallies come from the engine's terminal snapshot —
        // the run replayed one cached call and declared no phases — not from a
        // re-parse of the checkpoint's script.
        expect(errText).toContain('"phaseCount":0');
        expect(errText).toContain('"taskDone":1');
        expect(errText).toContain('"taskTotal":1');
      }),
  );

  it.effect(
    'settles failures from the touched journal without stale entries',
    () =>
      Effect.gen(function* () {
        const name = 'attempt-local-settlement';
        const baselineScript = `export const meta = {
  name: '${name}',
  description: 'seeds stale recovery entries',
}
await agent('stale file')
return await agent('malformed stale')`;
        const staleResult: RunEnd = {
          ...finalResult,
          output: {
            category: 'workflow',
            outputs: [{ ...paperOutput, relativePath: 'stale.tex' }],
            compileFailures: [],
            diffs: [],
          },
        };
        yield* runPersistedWorkflowScript({
          session: currentSession(),
          parentRunId: runId,
          checkpointId: checkpointIdFor(name),
          script: baselineScript,
          runAgent: ({ prompt }) =>
            Effect.succeed(
              prompt === 'stale file' ? staleResult : { malformed: true },
            ),
        });

        const currentResult: RunEnd = {
          ...finalResult,
          usage: RunUsageTotalsSchema.parse({ totalCost: 0.25 }),
          output: {
            category: 'workflow',
            outputs: [{ ...paperOutput, relativePath: 'current.tex' }],
            compileFailures: [],
            diffs: [],
          },
        };
        const ports = fakePorts();
        const strategy = createWorkflowScriptStrategy(
          strategyParams({
            name,
            script: `export const meta = {
  name: '${name}',
  description: 'fails after current work',
}
await agent('current file')
throw new Error('current revision failed')`,
            createRunAgent: (hooks) => (invocation) =>
              Effect.sync(() => {
                hooks.onCost(invocation, currentResult.usage?.totalCost);
                return currentResult;
              }),
          }),
        );

        const launchError = yield* Effect.flip(launchStrategy(strategy, ports));
        expect(launchError.message).toContain('current revision failed');
        expect(ports.recordCost.mock.calls).toEqual([[0.25], [0.25]]);
        const errText = yield* Effect.promise(() =>
          Promise.resolve(strategy.formatError(null, new Error('boom'))),
        );
        expect(errText).toContain('current.tex');
        expect(errText).not.toContain('stale.tex');
        expect(errText).toContain('"costUsd":0.25');
      }),
  );

  it.effect('retains live spend when the agent() result is malformed', () =>
    Effect.gen(function* () {
      const malformedScript = `export const meta = {
  name: 'malformed-cost',
  description: 'tests malformed journal cost settlement',
}
return await agent('saved call')`;
      const ports = fakePorts();
      const strategy = createWorkflowScriptStrategy(
        strategyParams({
          name: 'malformed-cost',
          script: malformedScript,
          createRunAgent: (hooks) => (invocation) =>
            Effect.sync(() => {
              hooks.onCost(invocation, 0.2);
              return { not: 'an agent result' };
            }),
        }),
      );

      const malformedError = yield* Effect.flip(
        launchStrategy(strategy, ports),
      );
      expect(malformedError.message).toContain(
        'Workflow agent() result is not a run result',
      );
      // The live candidate, then the failure path's settlement of that same
      // retained spend: the malformed result never reached the journal.
      expect(ports.recordCost.mock.calls).toEqual([[0.2], [0.2]]);

      // A well-formed but failed RunEnd fails the same way, naming its outcome
      // and error, rather than resolving an `{ outcome: 'failed' }` envelope.
      const failedStrategy = createWorkflowScriptStrategy(
        strategyParams({
          name: 'failed-outcome',
          script: malformedScript.replaceAll(
            'malformed-cost',
            'failed-outcome',
          ),
          createRunAgent: () => () =>
            Effect.succeed({
              ...finalResult,
              outcome: 'failed',
              error: { kind: 'unexpected', message: 'prover crashed' },
            }),
        }),
      );
      const failedError = yield* Effect.flip(launchStrategy(failedStrategy));
      expect(failedError.message).toContain(
        'Workflow agent() result ended with failed outcome: prover crashed.',
      );
    }),
  );
});

/** Let queued abort/skip handling settle without resolving a hung run. */
async function drainMacrotasks(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * A fake `runAgent` that stands in for the production runner. Each attempt
 * reports the run id it actually runs under to the engine — modeling how
 * the real runner reports the logical id on attempt 0 and an attempt-specific
 * id after a durable retry — and hangs until the per-call signal aborts (unless
 * it is the designated `succeedAtAttempt`), so a test can drive an interactive
 * skip/retry against a call that is genuinely in flight.
 */
function controllableRunAgent(config: {
  readonly attemptRunIds: readonly RunId[];
  /** 1-based attempt that settles with finalResult; earlier attempts hang.
   *  Omit so every attempt hangs until a control action resolves it. */
  readonly succeedAtAttempt?: number;
  readonly attemptCosts?: readonly number[];
}): {
  readonly createRunAgent: WorkflowScriptStrategyParams['createRunAgent'];
  readonly attemptStarted: (attempt: number) => Promise<void>;
  readonly attempts: () => number;
  readonly onCost: (cost: number) => void;
} {
  const attemptGates: ReturnType<typeof createDeferred<void>>[] = [];
  const gateFor = (
    attempt: number,
  ): ReturnType<typeof createDeferred<void>> => {
    while (attemptGates.length < attempt)
      attemptGates.push(createDeferred<void>());
    return attemptGates[attempt - 1]!;
  };
  const execIdForAttempt = (attempt: number): RunId =>
    config.attemptRunIds[
      Math.min(attempt - 1, config.attemptRunIds.length - 1)
    ]!;
  let attemptCount = 0;
  let reportCost: ((cost: number) => void) | undefined;
  const createRunAgent: WorkflowScriptStrategyParams['createRunAgent'] = (
    hooks,
  ) => {
    return (invocation) =>
      Effect.tryPromise({
        try: async () => {
          attemptCount += 1;
          const thisAttempt = attemptCount;
          const execId = execIdForAttempt(thisAttempt);
          // The production runner charges both channels from one callback: the
          // strategy's tracker (parent billing) and the engine's snapshot (per-call
          // spend on progress surfaces). The fake mirrors that pairing.
          reportCost = (cost) => {
            hooks.onCost(invocation, cost);
            invocation.report({ costUsd: cost });
          };
          invocation.report({ childRunId: execId });
          gateFor(thisAttempt).resolve();
          const attemptCost = config.attemptCosts?.[thisAttempt - 1];
          if (attemptCost !== undefined) reportCost(attemptCost);
          if (config.succeedAtAttempt !== thisAttempt) {
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
        },
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      });
  };
  return {
    createRunAgent,
    attemptStarted: (attempt) => gateFor(attempt).promise,
    attempts: () => attemptCount,
    onCost: (cost) => reportCost?.(cost),
  };
}

describe('createWorkflowScriptStrategy interactive controls', () => {
  // Real run ids: the production host always persists snapshots, so the
  // engine's snapshot schema validates every id these fakes report.
  const grandchildRunId = 'ccccc0000001' as RunId;

  it.effect(
    'skips an in-flight grandchild by run id via the session registry',
    () =>
      Effect.gen(function* () {
        const fake = controllableRunAgent({
          attemptRunIds: [grandchildRunId],
        });
        const strategy = createWorkflowScriptStrategy(
          strategyParams({
            name: 'strategy-test',
            createRunAgent: fake.createRunAgent,
          }),
        );

        const launch = yield* Effect.forkChild(launchStrategy(strategy));
        yield* Effect.promise(() => fake.attemptStarted(1));
        // An unknown run id no-ops (the call stays in flight)...
        workflowControls.control('ddddd0000009' as RunId, 'skip');
        // ...while the right one translates execId → index → engine skip.
        workflowControls.control(grandchildRunId, 'skip');

        const turn = yield* Fiber.join(launch);
        expect(turn.result).toBe(WORKFLOW_SKIPPED_RESULT);
        expect(fake.attempts()).toBe(1);
        // The registration is dropped when the run settles.
        workflowControls.control(grandchildRunId, 'skip');
      }),
  );

  it.effect(
    'retries an in-flight grandchild by run id, re-running the call',
    () =>
      Effect.gen(function* () {
        const fake = controllableRunAgent({
          attemptRunIds: [grandchildRunId],
          succeedAtAttempt: 2,
          attemptCosts: [0.1, 0.5],
        });
        const logger = new TraceEmitter();
        const completedTaskCosts: number[] = [];
        logger.subscribe((event) => {
          if (
            event.type === 'workflow.call' &&
            event.call.status === 'completed'
          ) {
            if (event.call.costUsd !== undefined) {
              completedTaskCosts.push(event.call.costUsd);
            }
          }
        });
        const ports = fakePorts();
        const strategy = createWorkflowScriptStrategy(
          strategyParams({
            name: 'strategy-test',
            logger,
            createRunAgent: fake.createRunAgent,
          }),
        );

        const launch = yield* Effect.forkChild(launchStrategy(strategy, ports));
        yield* Effect.promise(() => fake.attemptStarted(1));
        workflowControls.control(grandchildRunId, 'retry');

        const turn = yield* Fiber.join(launch);
        // The second attempt settles with the real result, and the call ran twice.
        expect(turn.result).toMatchObject({
          category: 'workflow',
          outcome: 'completed',
          cost: 0.42,
        });
        expect(fake.attempts()).toBe(2);
        expect(completedTaskCosts).toHaveLength(1);
        expect(completedTaskCosts[0]).toBeCloseTo(0.6);
        expect(ports.recordCost.mock.calls).toEqual([[0.1], [0.6], [0.6]]);
      }),
  );

  it.effect(
    'targets the attempt-specific run id after a durable retry advances it',
    () =>
      Effect.gen(function* () {
        // After a retry, the re-run registers its child run under an
        // attempt-specific id (not the logical id) — the id the roster exposes.
        // The control bridge must follow that id, not the stale logical one.
        const logicalRunId = grandchildRunId;
        const attemptRunId = 'ccccc0000002' as RunId;
        const fake = controllableRunAgent({
          attemptRunIds: [logicalRunId, attemptRunId],
        });
        const ports = fakePorts();
        let settled = false;
        const strategy = createWorkflowScriptStrategy(
          strategyParams({
            name: 'strategy-test',
            createRunAgent: fake.createRunAgent,
          }),
        );

        const launch = yield* Effect.forkChild(
          launchStrategy(strategy, ports).pipe(
            Effect.tap(() => Effect.sync(() => (settled = true))),
          ),
        );
        // Attempt 0 runs under the logical id; retry advances to attempt 1.
        yield* Effect.promise(() => fake.attemptStarted(1));
        workflowControls.control(logicalRunId, 'retry');
        yield* Effect.promise(() => fake.attemptStarted(2));

        // The stale logical id no longer maps to the in-flight attempt: a skip on
        // it must no-op, leaving the run pending.
        workflowControls.control(logicalRunId, 'skip');
        yield* Effect.promise(drainMacrotasks);
        expect(settled).toBe(false);

        // The attempt-specific id the roster exposes reaches the engine index.
        workflowControls.control(attemptRunId, 'skip');
        const turn = yield* Fiber.join(launch);
        expect(turn.result).toBe(WORKFLOW_SKIPPED_RESULT);
        expect(fake.attempts()).toBe(2);
      }),
  );

  it.effect(
    'reports skipped-attempt spend before the empty final journal',
    () =>
      Effect.gen(function* () {
        const fake = controllableRunAgent({
          attemptRunIds: [grandchildRunId],
        });
        const ports = fakePorts();
        const strategy = createWorkflowScriptStrategy(
          strategyParams({
            name: 'strategy-test',
            createRunAgent: fake.createRunAgent,
          }),
        );

        const launch = yield* Effect.forkChild(launchStrategy(strategy, ports));
        yield* Effect.promise(() => fake.attemptStarted(1));
        // Model tokens were spent before the user skipped the attempt.
        fake.onCost(0.42);
        workflowControls.control(grandchildRunId, 'skip');

        const turn = yield* Fiber.join(launch);
        expect(turn.result).toBe(WORKFLOW_SKIPPED_RESULT);
        expect(ports.recordCost.mock.calls).toEqual([[0.42], [0.42]]);
      }),
  );
});
