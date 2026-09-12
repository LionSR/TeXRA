import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Result } from 'effect';
import { describe, expect, vi } from 'vitest';

import { parseWorkflowScript } from '@agent/workflowScript/parseScript';
import { WorkflowRunAbortError } from '@agent/workflowScript/runWorkflowScript';
import type {
  WorkflowAgentInvocation,
  WorkflowScriptControl,
  WorkflowScriptRunOptions,
  WorkflowScriptRunResult,
} from '@agent/workflowScript/types';
import { runWorkflowScript } from '@agent/workflowScript/runWorkflowScript';
import { WORKFLOW_SKIPPED_RESULT } from '@agent/workflowScript/types';
import { runScriptInSandbox } from '@agent/workflowScript/sandbox';
import {
  deriveWorkflowCounts,
  deriveWorkflowStageState,
  type RunId,
} from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';

const META = `export const meta = {
  name: 'test-flow',
  description: 'engine test flow',
  phases: [{ title: 'Work' }],
}\n`;

function echoRunner(
  invocation: WorkflowAgentInvocation,
): Effect.Effect<string> {
  return Effect.succeed(`result:${invocation.prompt}`);
}

/** Captures every invocation while echoing its prompt, for later assertions. */
function collectingRunner(
  invocations: WorkflowAgentInvocation[],
): (invocation: WorkflowAgentInvocation) => Effect.Effect<string> {
  return (invocation) => {
    invocations.push(invocation);
    return echoRunner(invocation);
  };
}

/** Runs `body` under the shared META header, echoing prompts by default. */
function runScript(
  body: string,
  overrides: Partial<WorkflowScriptRunOptions> = {},
): Effect.Effect<WorkflowScriptRunResult, Error> {
  return runWorkflowScript({
    script: `${META}${body}`,
    runAgent: echoRunner,
    ...overrides,
  });
}

/** Assert on an Effect's typed failure without leaving the test runtime. */
function expectEffect<A, E, R>(effect: Effect.Effect<A, E, R>) {
  const assertFailure = (assertion: (error: E) => void) =>
    Effect.match(effect, {
      onFailure: assertion,
      onSuccess: () => expect.fail('Expected the Effect to fail'),
    });
  return {
    rejects: {
      toMatchObject: (expected: object) =>
        assertFailure((error) => {
          expect(error).toMatchObject(expected);
        }),
      toThrow: (expected?: string | RegExp) =>
        assertFailure((error) => {
          expect(() => {
            throw error;
          }).toThrow(expected);
        }),
    },
  };
}

const sleep = (milliseconds: number): Effect.Effect<void> =>
  Effect.sleep(milliseconds);

const waitFor = (assertion: () => void): Effect.Effect<void> =>
  Effect.suspend(() =>
    Result.isSuccess(Result.try(assertion))
      ? Effect.void
      : Effect.yieldNow.pipe(Effect.andThen(waitFor(assertion))),
  );

const fromPromise = <A>(promise: () => Promise<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({ try: promise, catch: ensureError });

/** Native callback effect for runner doubles controlled by the test. */
const controlledEffect = <A>(
  register: (succeed: (value: A) => void, fail: (error: Error) => void) => void,
): Effect.Effect<A, Error> =>
  Effect.callback((resume) =>
    register(
      (value) => resume(Effect.succeed(value)),
      (error) => resume(Effect.fail(error)),
    ),
  );

function rejectOnAbort(
  invocation: WorkflowAgentInvocation,
  reject: (error: Error) => void,
): void {
  invocation.signal.addEventListener(
    'abort',
    () => reject(new Error('aborted')),
    { once: true },
  );
}

/**
 * The child run id one attempt runs under. Interactive control is keyed
 * by the id the runner reports, so a fake runner announces one per attempt
 * exactly as the production runner does — and a retry announces a new one.
 */
function childRunIdFor(index: number, attempt = 1): RunId {
  return `child-${index}-${attempt}` as RunId;
}

const EMPTY_FILES_JSON = '{"inputFiles":[],"contextFiles":[],"mediaFiles":[]}';

type SandboxBridge = Parameters<typeof runScriptInSandbox>[1];

function sandboxBridge(overrides: Partial<SandboxBridge> = {}): SandboxBridge {
  return {
    asyncFns: {},
    syncFns: {},
    argsJson: undefined,
    filesJson: EMPTY_FILES_JSON,
    realmPrelude: '',
    ...overrides,
  };
}

describe('parseWorkflowScript', () => {
  it('extracts and validates the meta literal', () => {
    const { meta, body } = parseWorkflowScript(
      `${META}return await agent('x')`,
    );
    expect(meta.name).toBe('test-flow');
    expect(meta.phases?.[0]?.title).toBe('Work');
    expect(body).not.toContain('export ');
  });

  it('normalizes phase-title shorthand at the parser boundary', () => {
    const { meta } = parseWorkflowScript(`export const meta = {
  name: 'phase-shorthand',
  description: 'accepts the natural phase-title form',
  phases: ['Draft', { title: 'Merge' }],
}
return null`);

    expect(meta.phases).toEqual([{ title: 'Draft' }, { title: 'Merge' }]);
  });

  it('validates the declarative task plan as part of workflow metadata', () => {
    const { meta } = parseWorkflowScript(`export const meta = {
  name: 'planned',
  description: 'declares progress before run',
  phases: [{ title: 'Audit' }],
  tasks: [{ id: 'core', label: 'Audit core', phase: 'Audit' }],
}
return null`);
    expect(meta.tasks).toEqual([
      { id: 'core', label: 'Audit core', phase: 'Audit' },
    ]);

    expect(() =>
      parseWorkflowScript(`export const meta = {
  name: 'duplicate',
  description: 'invalid duplicate ids',
  tasks: [
    { id: 'same', label: 'First' },
    { id: 'same', label: 'Second' },
  ],
}
return null`),
    ).toThrow(/Duplicate task id "same"/);

    expect(() =>
      parseWorkflowScript(`export const meta = {
  name: 'unknown-phase',
  description: 'invalid phase reference',
  phases: [{ title: 'Known' }],
  tasks: [{ id: 'task', label: 'Task', phase: 'Unknown' }],
}
return null`),
    ).toThrow(/not declared in meta\.phases/);
  });

  it('rejects scripts without a leading meta export', () => {
    expect(() => parseWorkflowScript(`return 1`)).toThrow(
      /Workflow script must begin with `export const meta/,
    );
  });

  it('rejects meta failing schema validation', () => {
    expect(() =>
      parseWorkflowScript(`export const meta = { name: 'x' }\nreturn 1`),
    ).toThrow(/Invalid workflow meta/);
  });

  it('rejects unknown metadata and phase fields instead of dropping typos', () => {
    expect(() =>
      parseWorkflowScript(`export const meta = {
  name: 'typo',
  description: 'rejects misspelled fields',
  timeout: 1000,
}
return null`),
    ).toThrow(/Unrecognized key: "timeout"/);
    expect(() =>
      parseWorkflowScript(`export const meta = {
  name: 'phase-typo',
  description: 'rejects misspelled phase fields',
  phases: [{ title: 'Proof', details: 'misspelled' }],
}
return null`),
    ).toThrow(/Invalid input[\s\S]*phases\[0\]/);
  });

  it('rejects non-literal meta referencing script identifiers', () => {
    expect(() =>
      parseWorkflowScript(
        `export const meta = { name: buildName(), description: 'd' }\nreturn 1`,
      ),
    ).toThrow(/pure object literal/);
  });

  it('rejects module imports and require', () => {
    const sources = [
      `${META}const fs = require('node:fs')`,
      `import fs from 'node:fs'\n${META}`,
      `${META}return import('node:fs')`,
      `${META}return require\`node:fs\``,
    ];
    for (const source of sources) {
      expect(() => parseWorkflowScript(source)).toThrow(/cannot import/);
    }
  });

  it('does not confuse regex literals with module loading or structure', () => {
    const { body } = parseWorkflowScript(
      `${META}const pattern = /require\\s*\\(.*[{}]/\nreturn pattern.test('x')`,
    );
    expect(body).toContain('/require\\s*\\(.*[{}]/');
  });

  it('keeps top-level return and await valid after AST parsing', () => {
    expect(() =>
      parseWorkflowScript(`${META}return await agent('x')`),
    ).not.toThrow();
  });

  it('rejects meta whose accessors would hang host-side validation', () => {
    expect(() =>
      parseWorkflowScript(
        `export const meta = { get name() { while (true) {} }, description: 'd' }\nreturn 1`,
      ),
    ).toThrow(/pure object literal/);
  });

  it('handles braces inside meta strings and comments', () => {
    const { meta } = parseWorkflowScript(
      `export const meta = {
  name: 'braces',
  // a } comment
  description: 'has { braces } inside', /* and } here */
}\nreturn 1`,
    );
    expect(meta.description).toBe('has { braces } inside');
  });
});

describe('runWorkflowScript', () => {
  it.effect(
    'uses meta.tasks as the single source for task labels and phases',
    () =>
      Effect.gen(function* () {
        const transitions: WorkflowScriptRunResult['snapshot'][] = [];
        const runner = vi.fn(echoRunner);
        const run = yield* runWorkflowScript({
          script: `export const meta = {
  name: 'planned-run',
  description: 'runs a declared plan',
  phases: [{ title: 'Audit' }],
  tasks: [{ id: 'core', label: 'Audit core', phase: 'Audit' }],
}
return await agent('Inspect src', { id: 'core' })`,
          runAgent: runner,
          onTransition: (snapshot) =>
            transitions.push(structuredClone(snapshot)),
        });

        // The declared plan is published before the script issues any call.
        expect(transitions[0]?.calls).toMatchObject([
          {
            id: 'core',
            label: 'Audit core',
            status: 'declared',
          },
        ]);
        expect(runner.mock.calls[0][0].options).toMatchObject({
          id: 'core',
          label: 'Audit core',
          phase: 'Audit',
        });
        expect(run.snapshot.calls).toMatchObject([
          {
            id: 'core',
            label: 'Audit core',
            status: 'completed',
          },
        ]);
      }),
  );

  it.effect(
    'stamps sweep-settled outcomes first-class instead of note-sniffing',
    () =>
      Effect.gen(function* () {
        // One writer of call outcomes: the terminal sweep marks the calls it
        // settles (not-reached plans, abandoned live calls) with settledBySweep,
        // and a call that settled through its own path never carries the flag.
        const transitions: WorkflowScriptRunResult['snapshot'][] = [];
        const run = runWorkflowScript({
          script: `export const meta = {
  name: 'swept-run',
  description: 'leaves a declared task unreached',
  phases: [{ title: 'Audit' }],
  tasks: [
    { id: 'first', label: 'First', phase: 'Audit' },
    { id: 'second', label: 'Second', phase: 'Audit' },
  ],
}
await agent('Inspect src', { id: 'first' })
throw new Error('script stops before the second task')`,
          runAgent: echoRunner,
          onTransition: (snapshot) =>
            transitions.push(structuredClone(snapshot)),
        });

        yield* expectEffect(run).rejects.toMatchObject({
          message: expect.stringContaining(
            'script stops before the second task',
          ),
        });
        expect(transitions.at(-1)?.calls).toMatchObject([
          { id: 'first', status: 'completed' },
          { id: 'second', status: 'skipped', settledBySweep: true },
        ]);
        expect(transitions.at(-1)?.calls[0]).not.toHaveProperty(
          'settledBySweep',
          true,
        );
      }),
  );

  it.effect(
    'rejects calls outside a declared plan and conflicting presentation data',
    () =>
      Effect.gen(function* () {
        const plannedMeta = `export const meta = {
  name: 'strict-plan',
  description: 'requires task references',
  tasks: [{ id: 'known', label: 'Known task' }],
}
`;
        function expectPlanRejection(
          body: string,
          pattern: RegExp,
        ): Effect.Effect<void, never, never> {
          return expectEffect(
            runWorkflowScript({
              script: `${plannedMeta}${body}`,
              runAgent: echoRunner,
            }),
          ).rejects.toThrow(pattern);
        }

        yield* expectPlanRejection(
          `return await agent('missing id')`,
          /must reference a task from meta\.tasks/,
        );
        yield* expectPlanRejection(
          `return await agent('unknown', { id: 'other' })`,
          /undeclared task id "other"/,
        );
        yield* expectPlanRejection(
          `return await agent('conflict', {
  id: 'known',
  label: 'Conflicting label',
})`,
          /must use the label and phase declared in meta\.tasks/,
        );
        yield* expectPlanRejection(
          `return await parallel([
  () => agent('first use', { id: 'known' }),
  () => agent('second use', { id: 'known' }),
])`,
          /may be issued only once per run/i,
        );
      }),
  );

  it.effect(
    'accepts task presentation fields that exactly match the plan',
    () =>
      Effect.gen(function* () {
        const runner = vi.fn(echoRunner);
        yield* runWorkflowScript({
          script: `export const meta = {
  name: 'matching-plan',
  description: 'tolerates harmless model duplication',
  phases: ['Audit'],
  tasks: [{ id: 'known', label: 'Known task', phase: 'Audit' }],
}
return await agent('inspect', {
  id: 'known',
  label: '  Known task  ',
  phase: 'Audit',
})`,
          runAgent: runner,
        });

        expect(runner.mock.calls[0][0].options).toMatchObject({
          id: 'known',
          label: 'Known task',
          phase: 'Audit',
        });
      }),
  );

  it.effect('treats an explicitly empty task plan as closed', () =>
    Effect.gen(function* () {
      const emptyPlan = `export const meta = {
  name: 'empty-plan',
  description: 'declares that no agent work is planned',
  tasks: [],
}
`;
      function runEmptyPlan(
        body: string,
        overrides: Partial<WorkflowScriptRunOptions> = {},
      ): Effect.Effect<WorkflowScriptRunResult, Error> {
        return runWorkflowScript({
          script: `${emptyPlan}${body}`,
          runAgent: echoRunner,
          ...overrides,
        });
      }

      yield* expectEffect(
        runEmptyPlan(`return await agent('undeclared')`),
      ).rejects.toThrow(/Every agent\(\) call must reference a task/);

      const result = yield* runEmptyPlan(`return 'done'`);
      expect(result.result).toBe('done');
      // An explicitly empty plan owns no calls, and none may be added.
      expect(result.snapshot.calls).toEqual([]);
    }),
  );

  it.effect('runs a script end-to-end with agent calls and args', () =>
    Effect.gen(function* () {
      const runner = vi.fn(echoRunner);
      const run = yield* runScript(
        `
const a = await agent('alpha')
const b = await agent('beta:' + args.suffix)
return [a, b]`,
        { args: { suffix: 'S' }, runAgent: runner },
      );
      expect(run.result).toEqual(['result:alpha', 'result:beta:S']);
      expect(runner).toHaveBeenCalledTimes(2);
      expect(run.journal).toHaveLength(2);
    }),
  );

  it.effect('exposes launch files as immutable script context', () =>
    Effect.gen(function* () {
      const run = yield* runScript(
        `
return {
  files,
  frozen: Object.isFrozen(files) &&
    Object.values(files).every(Object.isFrozen),
}`,
        {
          files: {
            inputFiles: ['paper.tex'],
            contextFiles: ['references.bib'],
            mediaFiles: ['figure.pdf'],
          },
        },
      );

      expect(run.result).toEqual({
        files: {
          inputFiles: ['paper.tex'],
          contextFiles: ['references.bib'],
          mediaFiles: ['figure.pdf'],
        },
        frozen: true,
      });
    }),
  );

  it.effect(
    'passes a structured result from agent({ schema }) to the script and keys the journal by schema',
    () =>
      Effect.gen(function* () {
        const schema = {
          type: 'object',
          properties: { title: { type: 'string' } },
          required: ['title'],
          additionalProperties: false,
        };
        const keys: string[] = [];
        const run = yield* runWorkflowScript({
          script: `${META}
const withSchema = await agent('draft', { agentName: 'assistant', schema: args.schema })
const plain = await agent('draft')
return { structured: withSchema.structured, plain }`,
          args: { schema },
          runAgent: (invocation) => {
            keys.push(invocation.key);
            return Effect.succeed(
              invocation.options.schema
                ? {
                    category: 'toolUse',
                    outcome: 'completed',
                    response: '',
                    files: [],
                    cost: 0,
                    structured: { title: 'Lemma' },
                  }
                : `result:${invocation.prompt}`,
            );
          },
        });

        // The `.structured` envelope reaches the script unchanged.
        expect(run.result).toMatchObject({
          structured: { title: 'Lemma' },
          plain: 'result:draft',
        });
        // Same prompt, differing only by the schema option, must yield distinct
        // journal keys so resume identity tracks the schema.
        expect(keys).toHaveLength(2);
        expect(keys[0]).not.toBe(keys[1]);
      }),
  );

  it.effect(
    'normalizes per-call models and includes them in journal identity',
    () =>
      Effect.gen(function* () {
        const invocations: WorkflowAgentInvocation[] = [];
        const run = yield* runWorkflowScript({
          script: `${META}
const routine = await agent('draft', { model: 'economy-model' })
const difficult = await agent('draft', { model: 'strong-model' })
return [routine, difficult]`,
          runAgent: (invocation) => {
            invocations.push(invocation);
            return Effect.succeed(`result:${invocation.options.model}`);
          },
        });

        expect(run.result).toEqual([
          'result:economy-model',
          'result:strong-model',
        ]);
        expect(invocations.map(({ options }) => options.model)).toEqual([
          'economy-model',
          'strong-model',
        ]);
        expect(invocations[0]?.key).not.toBe(invocations[1]?.key);
      }),
  );

  it.effect('rejects a non-object schema option', () =>
    Effect.gen(function* () {
      yield* expectEffect(
        runScript(`return await agent('draft', { schema: 'nope' })`),
      ).rejects.toThrow(/schema.*must be a plain JSON Schema object/i);
    }),
  );

  it.effect('rejects an empty or regex-bearing structured-output schema', () =>
    Effect.gen(function* () {
      yield* expectEffect(
        runScript(`return await agent('draft', { schema: {} })`),
      ).rejects.toThrow(/schema.*object-root JSON Schema/i);
      yield* expectEffect(
        runScript(
          `return await agent('draft', { schema: { type: 'object', properties: { value: { type: 'string', pattern: '(a+)+$' } } } })`,
        ),
      ).rejects.toThrow(/cannot use pattern/i);
    }),
  );

  it.effect('requires explicit identities for otherwise-repeated calls', () =>
    Effect.gen(function* () {
      const invocations: WorkflowAgentInvocation[] = [];
      yield* runWorkflowScript({
        script: `${META}
return await parallel([
  () => agent('same', { id: ' first ' }),
  () => agent('different'),
  () => agent('same', { id: 'second' }),
])`,
        runAgent: collectingRunner(invocations),
      });

      expect(invocations.map(({ options }) => options.id)).toEqual([
        'first',
        undefined,
        'second',
      ]);
      expect(invocations.map(({ progressId }) => progressId)).toEqual([
        'first',
        'call-1',
        'second',
      ]);

      yield* expectEffect(
        runScript(`return await parallel([
  () => agent('first prompt', { id: 'shared-id' }),
  () => agent('second prompt', { id: 'shared-id' }),
])`),
      ).rejects.toThrow(/call id "shared-id" may be issued only once/i);

      yield* expectEffect(
        runScript(`return await parallel([
  () => agent('same'),
  () => agent('same'),
])`),
      ).rejects.toThrow(/require distinct non-empty "id" options/i);

      yield* expectEffect(
        runScript(`return await parallel([
  () => agent('same', { id: 'same-id' }),
  () => agent('same', { id: ' same-id ' }),
        ])`),
      ).rejects.toThrow(/call id "same-id" may be issued only once/i);
    }),
  );

  it.effect(
    'passes typed workflow outputs into the next stage input files',
    () =>
      Effect.gen(function* () {
        const outputPath =
          '/storage/executions/bbbbbb222222/r1/drafted-section.tex';
        const invocations: WorkflowAgentInvocation[] = [];
        const run = yield* runWorkflowScript({
          script: `${META}
const drafted = await agent('draft')
return await agent('merge', {
          inputFiles: drafted.outputs.map((output) => output.absolutePath),
})`,
          runAgent: (call) =>
            Effect.sync(() => {
              invocations.push(call);
              return {
                category: 'workflow',
                outcome: 'completed',
                outputs:
                  call.index === 0
                    ? [
                        {
                          round: 1,
                          relativePath: 'r1/drafted-section.tex',
                          absolutePath: outputPath,
                          location: 'runStorage',
                          originalPath: null,
                          added: null,
                          removed: null,
                        },
                      ]
                    : [],
                compileFailures: [],
                diffs: [],
                cost: 0,
              };
            }),
          fingerprintAgentDependencies: () =>
            Effect.succeed('drafted-section-v1'),
        });

        expect(invocations[1]?.options.inputFiles).toEqual([outputPath]);
        expect(run.result).toMatchObject({
          category: 'workflow',
          outcome: 'completed',
        });
      }),
  );

  it.effect(
    'parallel(): surfaces script errors instead of converting them to null',
    () =>
      Effect.gen(function* () {
        yield* expectEffect(
          runScript(`
return await parallel([
  () => agent('ok-1'),
  () => { throw new Error('thunk boom') },
  () => agent('ok-2'),
])`),
        ).rejects.toThrow('thunk boom');
      }),
  );

  it.effect(
    'parallel(): keeps a thunk error before launching queued siblings',
    () =>
      Effect.gen(function* () {
        const runner = vi.fn((invocation: WorkflowAgentInvocation) =>
          controlledEffect<never>((_resolve, reject) => {
            invocation.signal.addEventListener(
              'abort',
              () => {
                const error = new Error('runner observed cleanup abort');
                error.name = 'WorkflowRunAbortError';
                reject(error);
              },
              { once: true },
            );
          }),
        );

        yield* expectEffect(
          runScript(
            `
return await parallel([
  () => agent('running'),
  () => agent('queued'),
  () => { throw new Error('thunk boom') },
        ])`,
            { runAgent: runner, concurrency: 1 },
          ),
        ).rejects.toThrow('thunk boom');
        expect(runner).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'agent() resolves to null on runner failure and is not journaled',
    () =>
      Effect.gen(function* () {
        const runner = vi.fn((invocation: WorkflowAgentInvocation) =>
          invocation.prompt === 'boom'
            ? Effect.fail(new Error('runner failed'))
            : echoRunner(invocation),
        );
        const run = yield* runScript(
          `return [await agent('boom'), await agent('fine')]`,
          { runAgent: runner },
        );
        expect(run.result).toEqual([null, 'result:fine']);
        // Only the successful call is journaled, so a resume retries the failure.
        expect(run.journal.map((entry) => entry.index)).toEqual([1]);
      }),
  );

  it.live(
    'awaits durable journal hooks and excludes failed calls from them',
    () =>
      Effect.gen(function* () {
        const order: string[] = [];
        const settled = new Set<string>();
        const run = yield* runWorkflowScript({
          script: `${META}return [await agent('boom'), await agent('saved')]`,
          runAgent: ({ prompt }) =>
            Effect.sync(() => {
              if (prompt === 'boom') throw new Error('runner failed');
              order.push('runner');
              return 'saved result';
            }),
          onJournalEntry: (entry) =>
            Effect.gen(function* () {
              yield* sleep(5);
              order.push(`checkpoint:${entry.index}`);
            }),
          // The checkpoint is awaited before the call is observably completed, and
          // the failed call never reaches a checkpoint at all.
          onTransition: (snapshot) => {
            for (const call of snapshot.calls) {
              if (call.status !== 'completed' || settled.has(call.id)) continue;
              settled.add(call.id);
              order.push(`completed:${call.id}`);
            }
          },
        });

        expect(run.result).toEqual([null, 'saved result']);
        expect(order).toEqual(['runner', 'checkpoint:1', 'completed:call-1']);
      }),
  );

  it.live(
    'observes validated cache hits and live results after durable commit',
    () =>
      Effect.gen(function* () {
        const cached = yield* runScript(`return await agent('cached')`);
        const order: string[] = [];
        const run = yield* runWorkflowScript({
          script: `${META}
const cached = await agent('cached')
log('after cache')
const live = await agent('live')
log('after live')
return [cached, live]`,
          journal: cached.journal,
          runAgent: ({ prompt }) =>
            Effect.sync(() => {
              order.push(`runner:${prompt}`);
              return `result:${prompt}`;
            }),
          onJournalEntry: (entry) =>
            Effect.gen(function* () {
              yield* sleep(5);
              order.push(`checkpoint:${entry.index}`);
            }),
          onJournalEntryConsumed: (entry) => {
            order.push(`consumed:${entry.index}`);
          },
          onEvent: (event) => order.push(event.message),
        });

        expect(run.result).toEqual(['result:cached', 'result:live']);
        expect(order).toEqual([
          'consumed:0',
          'after cache',
          'runner:live',
          'checkpoint:1',
          'consumed:1',
          'after live',
        ]);
      }),
  );

  it.effect(
    'reports a synchronous snapshot-write failure instead of hanging',
    () =>
      Effect.gen(function* () {
        // A synchronous `onSnapshot` throw runs the coalescing writer's drain to
        // completion (`catch` and `finally` included) inside `publish`, so the
        // handle `publish` then stores is already settled and nothing clears it
        // again. A flush that waited on that handle unconditionally never
        // returned, hanging the run instead of reporting its checkpoint failure.
        yield* expectEffect(
          runWorkflowScript({
            script: `${META}return 'done'`,
            runAgent: echoRunner,
            onSnapshot: () =>
              Effect.sync(() => {
                throw new Error('snapshot sink offline');
              }),
          }),
        ).rejects.toMatchObject({ name: 'WorkflowRunAbortError' });
      }),
  );

  it.live(
    'caps concurrent agent() calls to the p-queue concurrency limit over a large fan-out',
    () =>
      Effect.gen(function* () {
        let inFlight = 0;
        let maxInFlight = 0;
        let completed = 0;
        const runner = (invocation: WorkflowAgentInvocation) =>
          Effect.gen(function* () {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            // Wide margin over the queue-add loop: the first `concurrency` runners
            // must all start before any of them settles, so saturation is
            // deterministic even under CI scheduler pressure.
            yield* sleep(10);
            inFlight -= 1;
            completed += 1;
            return invocation.prompt;
          });
        const run = yield* runScript(
          `
const items = Array.from({ length: 100 }, (_, i) => i)
const out = await parallel(items.map((n) => () => agent('call-' + n)))
return out.length`,
          { runAgent: runner, concurrency: 4 },
        );
        // The queue saturates the limit without exceeding it.
        expect(maxInFlight).toBe(4);
        expect(completed).toBe(100);
        expect(run.result).toBe(100);
      }),
  );

  it.effect('replays matching journal entries and re-runs edited calls', () =>
    Effect.gen(function* () {
      const script = `${META}
const a = await agent('stage-a')
const b = await agent('stage-b:' + a)
return b`;
      const first = yield* runWorkflowScript({ script, runAgent: echoRunner });
      expect(first.result).toBe('result:stage-b:result:stage-a');

      // Unchanged script: full cache hit, runner never called.
      const cachedRunner = vi.fn(echoRunner);
      const second = yield* runWorkflowScript({
        script,
        runAgent: cachedRunner,
        journal: first.journal,
      });
      expect(second.result).toBe(first.result);
      expect(cachedRunner).not.toHaveBeenCalled();

      // Edited second call: first replays from cache, second runs live.
      const editedRunner = vi.fn(echoRunner);
      const edited = yield* runScript(
        `
const a = await agent('stage-a')
const b = await agent('stage-b-EDITED:' + a)
return b`,
        { runAgent: editedRunner, journal: first.journal },
      );
      expect(edited.result).toBe('result:stage-b-EDITED:result:stage-a');
      expect(editedRunner).toHaveBeenCalledTimes(1);
      expect(editedRunner.mock.calls[0][0].prompt).toBe(
        'stage-b-EDITED:result:stage-a',
      );
    }),
  );

  it.effect(
    'keeps resume identity stable when planned presentation changes',
    () =>
      Effect.gen(function* () {
        const first = yield* runWorkflowScript({
          script: `export const meta = {
  name: 'planned-resume',
  description: 'first presentation',
  phases: [{ title: 'Draft' }],
  tasks: [{ id: 'inspect', label: 'Inspect draft', phase: 'Draft' }],
}
return await agent('Inspect src', { id: 'inspect' })`,
          runAgent: echoRunner,
        });
        const cachedRunner = vi.fn(echoRunner);

        const resumed = yield* runWorkflowScript({
          script: `export const meta = {
  name: 'planned-resume',
  description: 'revised presentation',
  phases: [{ title: 'Audit' }],
  tasks: [{ id: 'inspect', label: 'Audit implementation', phase: 'Audit' }],
}
return await agent('Inspect src', { id: 'inspect' })`,
          runAgent: cachedRunner,
          journal: first.journal,
        });

        expect(resumed.result).toBe(first.result);
        expect(cachedRunner).not.toHaveBeenCalled();
        // The call replays from cache under the revised presentation.
        expect(resumed.snapshot.calls).toMatchObject([
          {
            id: 'inspect',
            label: 'Audit implementation',
            stageId: 'stage-1',
            status: 'cached',
          },
        ]);
      }),
  );

  it.effect(
    'invalidates cached calls when referenced file contents change',
    () =>
      Effect.gen(function* () {
        const script = `${META}return await agent('review', {
  inputFiles: ['proof.tex'],
})`;
        let dependencyFingerprint = 'old-proof';
        const first = yield* runWorkflowScript({
          script,
          runAgent: () => Effect.succeed('old result'),
          fingerprintAgentDependencies: () =>
            Effect.succeed(dependencyFingerprint),
        });
        const runner = vi.fn(() => Effect.succeed('new result'));

        dependencyFingerprint = 'new-proof';
        const resumed = yield* runWorkflowScript({
          script,
          runAgent: runner,
          journal: first.journal,
          fingerprintAgentDependencies: () =>
            Effect.succeed(dependencyFingerprint),
        });

        expect(resumed.result).toBe('new result');
        expect(runner).toHaveBeenCalledOnce();
        expect(resumed.journal[0]?.key).not.toBe(first.journal[0]?.key);
      }),
  );

  it.effect(
    'replays file-backed calls only when their dependency fingerprint matches',
    () =>
      Effect.gen(function* () {
        const script = `${META}return await agent('review', {
  inputFiles: ['proof.tex'],
})`;
        const fingerprintAgentDependencies = () => Effect.succeed('same-proof');
        const first = yield* runWorkflowScript({
          script,
          runAgent: () => Effect.succeed('saved result'),
          fingerprintAgentDependencies,
        });
        const runner = vi.fn(() => Effect.succeed('must not run'));

        const resumed = yield* runWorkflowScript({
          script,
          runAgent: runner,
          journal: first.journal,
          fingerprintAgentDependencies,
        });

        expect(resumed.result).toBe('saved result');
        expect(runner).not.toHaveBeenCalled();
      }),
  );

  it.effect('requires hosts to fingerprint file-backed calls', () =>
    Effect.gen(function* () {
      yield* expectEffect(
        runScript(`return await agent('review', {
  inputFiles: ['proof.tex'],
})`),
      ).rejects.toThrow(/must fingerprint agent\(\) file dependencies/);
    }),
  );

  it.effect('rejects an empty host fingerprint for file-backed calls', () =>
    Effect.gen(function* () {
      yield* expectEffect(
        runScript(
          `return await agent('review', {
  inputFiles: ['proof.tex'],
})`,
          {
            fingerprintAgentDependencies: () =>
              Effect.succeed(undefined as never),
          },
        ),
      ).rejects.toThrow(/returned no fingerprint/);
    }),
  );

  it.effect('makes initial dependency fingerprint failures run-fatal', () =>
    Effect.gen(function* () {
      const fingerprintError = new Error('proof.tex became unreadable');
      const runner = vi.fn(echoRunner);

      yield* expectEffect(
        runWorkflowScript({
          script: `${META}return await agent('review', {
  inputFiles: ['proof.tex'],
})`,
          runAgent: runner,
          fingerprintAgentDependencies: () =>
            Effect.sync(() => {
              throw fingerprintError;
            }),
        }),
      ).rejects.toMatchObject({
        name: 'WorkflowRunAbortError',
        message: expect.stringContaining(fingerprintError.message),
        cause: fingerprintError,
      });
      expect(runner).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    'refreshes file identity after waiting in the concurrency queue',
    () =>
      Effect.gen(function* () {
        const script = `${META}return await parallel([
  () => agent('blocker', { id: 'blocker' }),
  () => agent('review', { id: 'review', inputFiles: ['proof.tex'] }),
])`;
        const firstBlocked = yield* Deferred.make<void>();
        let fingerprint = 'old-proof';
        const invocations: WorkflowAgentInvocation[] = [];
        const runFiber = yield* runWorkflowScript({
          script,
          concurrency: 1,
          fingerprintAgentDependencies: () => Effect.succeed(fingerprint),
          runAgent: (invocation) =>
            Effect.gen(function* () {
              invocations.push(invocation);
              if (invocation.options.id === 'blocker') {
                yield* Deferred.await(firstBlocked);
              }
              return invocation.options.id ?? 'missing-id';
            }),
        }).pipe(Effect.forkChild);

        yield* waitFor(() => expect(invocations).toHaveLength(1));
        fingerprint = 'new-proof';
        yield* Deferred.succeed(firstBlocked, undefined);
        const run = yield* Fiber.join(runFiber);

        // The refresh is observable as the journal key it re-keys: against a
        // baseline run whose bytes never changed, only the file-backed call's
        // identity moves.
        const baseline = yield* runWorkflowScript({
          script,
          concurrency: 1,
          fingerprintAgentDependencies: () => Effect.succeed('old-proof'),
          runAgent: (invocation) => Effect.succeed(invocation.options.id),
        });
        expect(run.journal[0]?.key).toBe(baseline.journal[0]?.key);
        expect(run.journal[1]?.key).not.toBe(baseline.journal[1]?.key);
      }),
  );

  it.effect('refreshes file identity before an interactive retry', () =>
    Effect.gen(function* () {
      let control!: WorkflowScriptControl;
      let fingerprint = 'old-proof';
      const invocations: WorkflowAgentInvocation[] = [];
      const runner = (invocation: WorkflowAgentInvocation) =>
        controlledEffect<string>((resolve, reject) => {
          invocations.push(invocation);
          invocation.report({
            childRunId: childRunIdFor(invocation.index, invocations.length),
          });
          if (invocations.length === 2) resolve('fresh result');
          rejectOnAbort(invocation, reject);
        });
      const runFiber = yield* runWorkflowScript({
        script: `${META}return await agent('review', {
  inputFiles: ['proof.tex'],
})`,
        runAgent: runner,
        fingerprintAgentDependencies: () => Effect.succeed(fingerprint),
        onControl: (handle) => {
          control = handle;
        },
      }).pipe(Effect.forkChild);

      yield* waitFor(() => expect(invocations).toHaveLength(1));
      const firstKey = invocations[0]?.key;
      fingerprint = 'new-proof';
      control(childRunIdFor(0), 'retry');
      const run = yield* Fiber.join(runFiber);

      expect(invocations[1]?.key).not.toBe(firstKey);
      expect(run.journal[0]?.key).toBe(invocations[1]?.key);
    }),
  );

  it.effect(
    'ends a cached call with an error when its journal value is invalid',
    () =>
      Effect.gen(function* () {
        const script = `${META}return await agent('cached')`;
        const first = yield* runWorkflowScript({
          script,
          runAgent: echoRunner,
        });
        const snapshots: WorkflowScriptRunResult['snapshot'][] = [];
        const runner = vi.fn(echoRunner);

        yield* expectEffect(
          runWorkflowScript({
            script,
            runAgent: runner,
            journal: [{ ...first.journal[0], result: () => undefined }],
            onSnapshot: (snapshot) =>
              Effect.sync(() => {
                snapshots.push(snapshot);
              }),
          }),
        ).rejects.toThrow(/Cached agent\(\) result must be JSON-serializable/i);

        expect(runner).not.toHaveBeenCalled();
        // A cached call that fails validation settles as failed with the real
        // cause; the terminal pass must not reclassify it as never-reached.
        const terminal = snapshots.at(-1);
        expect(terminal?.outcome).toBe('failed');
        expect(terminal?.calls).toMatchObject([
          {
            id: 'call-0',
            label: 'cached',
            status: 'failed',
            error: expect.stringMatching(/must be JSON-serializable/i),
          },
        ]);
        expect(deriveWorkflowCounts(terminal?.calls ?? [])).toMatchObject({
          failed: 1,
          skipped: 0,
        });
      }),
  );

  it.effect('blocks Date.now() and Math.random() inside scripts', () =>
    Effect.gen(function* () {
      yield* expectEffect(runScript(`return Date.now()`)).rejects.toThrow(
        /Date\.now\(\) is unavailable/,
      );
      yield* expectEffect(runScript(`return Math.random()`)).rejects.toThrow(
        /Math\.random\(\) is unavailable/,
      );
    }),
  );

  it.effect('enforces the lifetime agent-call cap', () =>
    Effect.gen(function* () {
      yield* expectEffect(
        runScript(
          `
for (let i = 0; i < 10; i++) await agent('call-' + i)
return 'done'`,
          { maxAgentCalls: 3 },
        ),
      ).rejects.toThrow(/agent-call cap/);
    }),
  );

  it.effect('journal replays do not consume the live agent-call cap', () =>
    Effect.gen(function* () {
      const script = `${META}
const a = await agent('one')
const b = await agent('two')
return [a, b]`;
      const first = yield* runWorkflowScript({ script, runAgent: echoRunner });
      expect(first.journal).toHaveLength(2);

      // Resume with both calls cached plus one new live call, under a cap
      // that the total call count exceeds but the live count does not.
      const liveRunner = vi.fn(echoRunner);
      const resumed = yield* runWorkflowScript({
        script: `${META}
const a = await agent('one')
const b = await agent('two')
return await agent('three:' + a + b)`,
        runAgent: liveRunner,
        journal: first.journal,
        maxAgentCalls: 1,
      });
      expect(liveRunner).toHaveBeenCalledTimes(1);
      expect(resumed.result).toBe('result:three:result:oneresult:two');
    }),
  );

  it.effect(
    'defaults agent phase to the active phase() and records it on the snapshot',
    () =>
      Effect.gen(function* () {
        const invocations: WorkflowAgentInvocation[] = [];
        const run = yield* runWorkflowScript({
          script: `${META}
phase('Work')
await agent('inside', { label: 'labelled' })
return null`,
          runAgent: collectingRunner(invocations),
        });
        expect(invocations[0].options.phase).toBe('Work');
        expect(run.snapshot.stages).toMatchObject([
          { id: 'stage-1', title: 'Work', order: 0 },
        ]);
        expect(
          deriveWorkflowStageState(run.snapshot, run.snapshot.stages[0]!),
        ).toMatchObject({ outcome: 'completed' });
        expect(run.snapshot.calls).toMatchObject([
          {
            id: 'call-0',
            label: 'labelled',
            stageId: 'stage-1',
            status: 'completed',
          },
        ]);
      }),
  );

  it.effect(
    'normalizes executable phase titles to the declared metadata title',
    () =>
      Effect.gen(function* () {
        const invocations: WorkflowAgentInvocation[] = [];
        const run = yield* runWorkflowScript({
          script: `export const meta = {
  name: 'trimmed-phase',
  description: 'normalizes phase titles',
  phases: [{ title: '  Work  ' }],
}
const early = agent('early', { label: 'Early', phase: '  Work  ' })
phase('  Work  ')
await early
return await agent('active', { label: 'Active' })`,
          runAgent: collectingRunner(invocations),
        });

        expect(
          invocations.map((invocation) => invocation.options.phase),
        ).toEqual(['Work', 'Work']);
        // One normalized stage owns both calls, whichever spelling reached it.
        expect(run.snapshot.stages).toMatchObject([
          { id: 'stage-1', title: 'Work', order: 0 },
        ]);
        expect(run.snapshot.calls).toMatchObject([
          { label: 'Early', stageId: 'stage-1' },
          { label: 'Active', stageId: 'stage-1' },
        ]);
      }),
  );

  it.effect('rejects invalid primitive usage with clear errors', () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, RegExp]> = [
        [`return await agent('')`, /non-empty string prompt/],
        [`return await parallel('nope')`, /array of zero-arg functions/],
        [
          `return await parallel([() => agent('x'), 42])`,
          /parallel\(\): item 1 is not a function/,
        ],
        [`return await agent('x', [])`, /must be a plain object/],
        [
          `return await agent('x', { inputFiles: [''] })`,
          /inputFiles.*arrays of non-empty strings/,
        ],
        [
          `return await agent('x', { inputFiles: ['   '] })`,
          /inputFiles.*arrays of non-empty strings/,
        ],
        [
          `return await agent('x', { model: '  ' })`,
          /option "model" must be a non-empty string/,
        ],
        [`phase('   ')\nreturn null`, /Workflow phase title must not be blank/],
        [
          `return await agent('work', { phase: '   ' })`,
          /option "phase" must be a non-empty string/,
        ],
      ];
      for (const [body, pattern] of cases) {
        yield* expectEffect(runScript(body)).rejects.toThrow(pattern);
      }
    }),
  );

  it.effect(
    'separates workflow file options from structured tool-use calls',
    () =>
      Effect.gen(function* () {
        yield* expectEffect(
          runScript(`return await agent('x', {
  agentName: 'assistant',
  schema: { type: 'object' },
  contextFiles: ['notes.tex'],
})`),
        ).rejects.toThrow(/structured-output calls cannot use file options/);
        yield* expectEffect(
          runScript(`return await agent('x', {
  schema: { type: 'object' },
})`),
        ).rejects.toThrow(/must name a tool-use agent/);
      }),
  );

  it.effect(
    'does not let fan-out swallow invalid structured-call declarations',
    () =>
      Effect.gen(function* () {
        yield* expectEffect(
          runScript(`return await parallel([
  () => agent('x', { schema: { type: 'object' } }),
])`),
        ).rejects.toMatchObject({
          name: 'WorkflowRunAbortError',
          message: expect.stringContaining('must name a tool-use agent'),
        });
      }),
  );

  it.effect(
    'accepts a schema option and rejects obsolete or misspelled options',
    () =>
      Effect.gen(function* () {
        const seen: WorkflowAgentInvocation[] = [];
        const runner = collectingRunner(seen);
        yield* runScript(
          `
return await agent('a', { agentName: 'assistant', schema: { type: 'object' } })`,
          { runAgent: runner },
        );

        expect(seen[0]?.options.schema).toMatchObject({
          type: 'object',
          properties: {},
        });
        yield* expectEffect(
          runScript(
            `return await agent('b', {
  outputSchema: { type: 'object' },
})`,
            { runAgent: runner },
          ),
        ).rejects.toThrow(/option "outputSchema" is not recognized/);
      }),
  );

  it.effect(
    'normalizes agent() options without synthesizing journal-key fields',
    () =>
      Effect.gen(function* () {
        // The journal key is a stable hash of the normalized options, so an option
        // the guest omitted must stay omitted: a prefaulted empty file list (or any
        // other synthesized key) would silently invalidate every completed call of
        // an otherwise identical resumed run.
        const seen: WorkflowAgentInvocation[] = [];
        const runner = collectingRunner(seen);
        // Only defined values reach stableStringify, so this is exactly the key set
        // the journal identity is computed over.
        const journaledOptionKeys = (index: number): string[] =>
          Object.entries(seen[index]?.options ?? {})
            .filter(([, value]) => value !== undefined)
            .map(([key]) => key)
            .toSorted();

        yield* runScript(
          `
await agent('bare')
await agent('files', { inputFiles: ['  draft.tex  '], label: '  ' })
return await agent('structured', {
  id: '  audit  ',
  model: '  sonnet  ',
  agentName: ' assistant ',
  schema: { type: 'object' },
})`,
          {
            runAgent: runner,
            fingerprintAgentDependencies: () => Effect.succeed('draft-v1'),
          },
        );

        expect(journaledOptionKeys(0)).toEqual([]);
        expect(journaledOptionKeys(1)).toEqual(['inputFiles', 'label']);
        // Only the supplied file role travels; the other two stay absent.
        expect(seen[1]?.options.inputFiles).toEqual(['draft.tex']);
        expect(seen[1]?.options.label).toBe('');
        expect(journaledOptionKeys(2)).toEqual([
          'agentName',
          'id',
          'model',
          'schema',
        ]);
        expect(seen[2]?.options.id).toBe('audit');
        expect(seen[2]?.options.model).toBe('sonnet');
        // agentName is the one string option taken verbatim: it names a host agent,
        // so a stray space must fail visibly at resolution rather than be repaired
        // into a different journal identity.
        expect(seen[2]?.options.agentName).toBe(' assistant ');
      }),
  );

  it.effect(
    'blocks Function-constructor escapes through injected primitives',
    () =>
      Effect.gen(function* () {
        // agent is a realm-local wrapper, so its .constructor is the sandbox's
        // codeGeneration-gated (Async)Function — compiling from strings throws.
        yield* expectEffect(
          runScript(`return agent.constructor('return process')()`),
        ).rejects.toThrow(/disallowed/i);
      }),
  );

  it.effect(
    'does not leak a host Function via a callback passed to parallel()',
    () =>
      Effect.gen(function* () {
        // parallel runs realm-side, so the thunk a script hands it is only ever
        // invoked by sandbox code: its `this`/args and any
        // .constructor it can reach are realm-local and codegen-gated. A host
        // callback would carry the ungated host Function constructor.
        const run = yield* runScript(`
const results = await parallel([
  () => {
    try {
      // If parallel() were host-side, the thunk's own constructor chain
      // would reach the host Function; realm-side it hits the gated one.
      const F = (() => {}).constructor
      return F('return typeof process')()
    } catch (error) {
      return 'blocked:' + (error && error.name)
    }
  },
])
return results[0]`);
        expect(typeof run.result).toBe('string');
        expect(run.result).toMatch(/^blocked:/);
      }),
  );

  it('parses meta strings containing astral Unicode without shifting offsets', () => {
    const { meta } = parseWorkflowScript(
      `export const meta = {
  name: 'emoji-flow',
  // comment with an emoji 😀 and a symbol 𝕏
  description: 'progress 😀 report 𝕏 done',
}\nreturn 1`,
    );
    expect(meta.name).toBe('emoji-flow');
    expect(meta.description).toBe('progress 😀 report 𝕏 done');
  });

  it.effect(
    'keeps resolve callbacks realm-local for a malicious thenable',
    () =>
      Effect.gen(function* () {
        // parallel() awaits thunk results realm-side, so a hand-rolled thenable
        // receives a realm-created resolve callback — its .constructor is the
        // sandbox's codegen-gated Function, so the escape attempt throws and
        // the thenable can only resolve with data.
        const run = yield* runScript(`
const results = await parallel([
  () => ({
    then(resolve) {
      try {
        resolve('leaked:' + resolve.constructor('return typeof process')())
      } catch (error) {
        resolve('blocked:' + (error && error.name))
      }
    },
  }),
])
return results[0]`);
        expect(run.result).toMatch(/^blocked:/);
      }),
  );

  it.live(
    'reports an unserializable return value as an error, not a timeout',
    () =>
      Effect.gen(function* () {
        // A BigInt (or circular object) cannot be JSON-encoded; the realm-side
        // deliver must route that through the error path immediately instead of
        // throwing and leaving the host promise to hang until the wall clock.
        yield* expectEffect(
          runScript(`return 1n`, { timeoutMs: 5_000 }),
        ).rejects.toThrow(/not JSON-serializable/i);
      }),
  );

  it.live('carries guest stack frames on script errors', () =>
    Effect.gen(function* () {
      // The classic un-awaited fan-out mistake: destructuring the Promise that
      // parallel() returns. The bare QuickJS message ("value is not iterable")
      // is useless without the frame locating it inside the script.
      yield* expectEffect(
        runScript(
          `
const [a, b] = parallel([() => agent('x'), () => agent('y')])
return a`,
          { timeoutMs: 5_000 },
        ),
      ).rejects.toThrow(
        /is not iterable[\s\S]*at .*test-flow\.workflow\.js:\d+/,
      );
    }),
  );

  it.effect('cannot forge a result by overriding Promise.prototype.then', () =>
    Effect.gen(function* () {
      // then/catch/finally are locked non-writable before the body runs, so a
      // script that tries to reassign then (to invoke the kickoff's delivery
      // callback with a forged value) gets a real result — the reassignment
      // throws under strict mode, or is simply ignored — not a forged success.
      const run = yield* runScript(`
try {
  Promise.prototype.then = function () { return this }
} catch (error) {
  // strict-mode assignment to a non-writable property throws; swallow it
}
return 'real-result'`);
      expect(run.result).toBe('real-result');
    }),
  );

  it.effect('does not expose the result delivery channel to scripts', () =>
    Effect.gen(function* () {
      // The kickoff captures and deletes __wfDeliver/__wfBody before the body
      // runs, so a script cannot forge an early result through them.
      const run = yield* runScript(`
return [typeof globalThis.__wfDeliver, typeof globalThis.__wfBody]`);
      expect(run.result).toEqual(['undefined', 'undefined']);
    }),
  );

  it.effect(
    'keeps a delivered result when a later guest microtask throws',
    () =>
      Effect.gen(function* () {
        const run = yield* runScript(`
Promise.resolve().then(() => {
  Promise.resolve().then(() => { throw new Error('late rejection') })
})
return 'delivered'`);

        expect(run.result).toBe('delivered');
      }),
  );

  it.live(
    'does not time out a delivered result while preempting leftover work',
    () =>
      Effect.gen(function* () {
        const onTimeout = vi.fn();
        const result = yield* fromPromise(() =>
          runScriptInSandbox(
            `
Promise.resolve().then(() => {
  Promise.resolve().then(() => { while (true) {} })
})
return 'delivered'`,
            sandboxBridge(),
            {
              filename: 'delivered-before-deadline.workflow.js',
              timeoutMs: 40,
              onTimeout,
            },
          ),
        );

        expect(result).toBe('delivered');
        expect(onTimeout).not.toHaveBeenCalled();
      }),
  );

  it.live(
    'derives a stage end from its calls, not from the run terminal instant',
    () =>
      Effect.gen(function* () {
        const run = yield* runWorkflowScript({
          script: `export const meta = {
  name: 'sweep-stage',
  description: 'distinguishes settled work from terminal-sweep work',
  phases: ['Settled', 'A', 'B', 'C'],
  tasks: [
    { id: 'settled', label: 'Settled normally', phase: 'Settled' },
    { id: 'live', label: 'Ignores cancellation', phase: 'A' },
    { id: 'unreached', label: 'Never issued', phase: 'B' },
    { id: 'bypassed', label: 'Never reached', phase: 'C' },
  ],
}
phase('Settled')
await agent('settles normally', { id: 'settled' })
phase('A')
agent('ignores cancellation', { id: 'live' })
phase('B')
return 'done'`,
          runAgent: (invocation) =>
            invocation.prompt === 'settles normally'
              ? Effect.sleep(5).pipe(Effect.as('done'))
              : Effect.never,
        });

        expect(run.snapshot.outcome).toBe('completed');
        expect(run.snapshot.calls).toMatchObject([
          { id: 'settled', status: 'completed' },
          { id: 'live', status: 'failed', settledBySweep: true },
          { id: 'unreached', status: 'skipped', settledBySweep: true },
          { id: 'bypassed', status: 'skipped', settledBySweep: true },
        ]);
        expect(run.snapshot.calls[0]).not.toHaveProperty(
          'settledBySweep',
          true,
        );
        const [settledStage, sweptStage, enteredStage, bypassedStage] =
          run.snapshot.stages.map((stage) =>
            deriveWorkflowStageState(run.snapshot, stage),
          );
        const terminalAt = run.snapshot.timestamps.completedAt;
        expect(settledStage).toMatchObject({ outcome: 'completed' });
        expect(settledStage?.completedAt).toBeDefined();
        // A stage whose own call the sweep failed reads failed, at the run's
        // terminal instant rather than an end of its own.
        expect(sweptStage).toMatchObject({
          outcome: 'failed',
          completedAt: terminalAt,
        });
        // B was entered and issued nothing before the run ended, so the run's
        // own outcome is its outcome.
        expect(enteredStage).toMatchObject({
          started: true,
          outcome: 'completed',
          completedAt: terminalAt,
        });
        // C was never entered: a swept plan label is not work it did, so it
        // has no end and no outcome at all rather than reading completed.
        expect(bypassedStage).toEqual({
          current: false,
          started: false,
          outcome: undefined,
          completedAt: undefined,
        });
      }),
  );

  it.effect('gives scripts realm-local agent results, not host objects', () =>
    Effect.gen(function* () {
      const runner = () => Effect.succeed({ nested: { data: 42 } });
      const run = yield* runScript(
        `
const r = await agent('x')
try {
  return r.constructor.constructor('return typeof process')()
} catch {
  return 'blocked:' + r.nested.data
}`,
        { runAgent: runner },
      );
      expect(run.result).toBe('blocked:42');
    }),
  );

  it('allows require/import mentions inside strings and comments', () => {
    const { meta } = parseWorkflowScript(`${META}
// you could import('node:fs') here, hypothetically
const note = "prompts may mention require('node:fs') as prose"
return note`);
    expect(meta.name).toBe('test-flow');
  });

  it('anchors meta to the script start, allowing only comments before it', () => {
    expect(() =>
      parseWorkflowScript(`const early = 1\n${META}return early`),
    ).toThrow(/must begin/);
    const { meta } = parseWorkflowScript(`// header comment\n${META}return 1`);
    expect(meta.name).toBe('test-flow');
  });

  it.effect(
    'keeps determinism guards non-writable and blocks argless new Date()',
    () =>
      Effect.gen(function* () {
        // Strict mode makes assignment to the non-writable guard throw outright.
        yield* expectEffect(
          runScript(`
Math.random = () => 0.5
return Math.random()`),
        ).rejects.toThrow(/read.?only|unavailable/i);
        yield* expectEffect(runScript(`return new Date()`)).rejects.toThrow(
          /new Date\(\) without arguments/,
        );
        const explicit = yield* runScript(`return new Date(0).getTime()`);
        expect(explicit.result).toBe(0);
        // Date.prototype.constructor is locked too, so a script cannot reassign
        // it to smuggle the unguarded constructor back onto instances.
        yield* expectEffect(
          runScript(`
Date.prototype.constructor = function () { return { now: () => 1 } }
return 'reassigned'`),
        ).rejects.toThrow(/read.?only|Cannot assign/i);
      }),
  );

  it.effect('does not let parallel() swallow the agent-call cap', () =>
    Effect.gen(function* () {
      yield* expectEffect(
        runScript(
          `
return await parallel([1, 2, 3, 4, 5].map((n) => () => agent('call-' + n)))`,
          { maxAgentCalls: 3 },
        ),
      ).rejects.toThrow(/agent-call cap/);
    }),
  );

  it.effect(
    'lets parallel() surface script bugs to the editable-file retry path',
    () =>
      Effect.gen(function* () {
        yield* expectEffect(
          runScript(`
return await parallel([
  () => agent('ok'),
  () => { throw new Error('script bug here') },
])`),
        ).rejects.toThrow('script bug here');
      }),
  );

  it.live('aborts new agent calls after the wall-clock timeout', () =>
    Effect.gen(function* () {
      let calls = 0;
      let sawAbort = false;
      const runner = (invocation: WorkflowAgentInvocation) =>
        Effect.gen(function* () {
          calls += 1;
          invocation.signal.addEventListener('abort', () => {
            sawAbort = true;
          });
          // Wide margin over timeoutMs: the timeout timer must fire before this
          // runner resolves even under heavy CI scheduler pressure, or the
          // orphaned continuation could reach agent('two') before the abort.
          yield* sleep(150);
          return invocation.prompt;
        });
      yield* expectEffect(
        runScript(
          `
await agent('one')
return await agent('two')`,
          { runAgent: runner, timeoutMs: 50 },
        ),
      ).rejects.toThrow(/timed out/);
      // Let the orphaned continuation reach its second agent() call.
      yield* sleep(250);
      expect(calls).toBe(1);
      // The endless guest continuation can win before the sibling is admitted;
      // either way the workflow is preempted at its wall-clock boundary.
    }),
  );

  it.live('honors meta.timeoutMs when no run option is given', () =>
    Effect.gen(function* () {
      yield* expectEffect(
        runWorkflowScript({
          script: `export const meta = {
  name: 'engine-test',
  description: 'meta-declared wall clock',
  timeoutMs: 1000,
}
return await agent('one')`,
          runAgent: () =>
            Effect.gen(function* () {
              yield* sleep(2_500);
              return 'late';
            }),
        }),
      ).rejects.toThrow(/timed out/);
    }),
  );

  it.live('lets an explicit run option override meta.timeoutMs', () =>
    Effect.gen(function* () {
      const startedAt = Date.now();
      yield* expectEffect(
        runWorkflowScript({
          script: `export const meta = {
  name: 'engine-test',
  description: 'run option beats meta',
  timeoutMs: 3600000,
}
return await agent('one')`,
          runAgent: () =>
            Effect.gen(function* () {
              yield* sleep(300);
              return 'late';
            }),
          timeoutMs: 40,
        }),
      ).rejects.toThrow(/timed out/);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    }),
  );

  it.effect.each([
    { reachedVia: 'an agent await', body: `await agent('one')` },
    {
      reachedVia: 'the guest microtask queue',
      body: `await Promise.resolve()`,
    },
  ])('preempts a CPU loop reached through $reachedVia', ({ body }) =>
    Effect.gen(function* () {
      const startedAt = Date.now();
      yield* expectEffect(
        runScript(
          `
${body}
while (true) {}`,
          { timeoutMs: 40 },
        ),
      ).rejects.toThrow(/timed out/);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    }),
  );

  it.live(
    'ignores a host promise that settles after its runtime is disposed',
    () =>
      Effect.gen(function* () {
        let resolveHost!: (payload: string) => void;
        const hostResult = new Promise<string>((resolve) => {
          resolveHost = resolve;
        });
        const onTimeout = vi.fn();

        yield* expectEffect(
          fromPromise(() =>
            runScriptInSandbox(
              `await agent('slow'); return 'unreachable'`,
              sandboxBridge({ asyncFns: { agent: () => hostResult } }),
              {
                filename: 'late-host-promise.workflow.js',
                timeoutMs: 30,
                onTimeout,
              },
            ),
          ),
        ).rejects.toThrow(/timed out/);

        resolveHost('"late"');
        yield* sleep(0);
        expect(onTimeout).toHaveBeenCalledTimes(1);

        const nextRun = yield* runScript(`return 7`);
        expect(nextRun.result).toBe(7);
      }),
  );

  it.live(
    'surfaces malformed host result JSON instead of substituting a value',
    () =>
      Effect.gen(function* () {
        yield* expectEffect(
          fromPromise(() =>
            runScriptInSandbox(
              `return await agent('malformed')`,
              sandboxBridge({
                asyncFns: { agent: () => Promise.resolve('{') },
              }),
              {
                filename: 'malformed-host-result.workflow.js',
                timeoutMs: 1_000,
              },
            ),
          ),
        ).rejects.toThrow(/expecting property name|JSON|unexpected end/i);
      }),
  );

  it.effect(
    'rejects non-serializable agent results instead of journaling null',
    () =>
      Effect.gen(function* () {
        const snapshots: WorkflowScriptRunResult['snapshot'][] = [];
        yield* expectEffect(
          runWorkflowScript({
            script: `${META}return await agent('function-result')`,
            runAgent: (invocation) =>
              Effect.sync(() => {
                invocation.report({ model: 'serialization-model' });
                return () => undefined;
              }),
            onSnapshot: (snapshot) =>
              Effect.sync(() => {
                snapshots.push(snapshot);
              }),
          }),
        ).rejects.toThrow(/agent\(\) result must be JSON-serializable/i);
        // The call ran once and settled failed with the serialization cause.
        expect(snapshots.at(-1)?.calls).toMatchObject([
          {
            id: 'call-0',
            label: 'function-result',
            status: 'failed',
            error: expect.stringMatching(/must be JSON-serializable/i),
            model: 'serialization-model',
            attempts: [{ number: 1, completedAt: expect.any(String) }],
          },
        ]);
      }),
  );

  it.effect('rejects explicitly supplied non-serializable workflow args', () =>
    Effect.gen(function* () {
      yield* expectEffect(
        runScript(`return args`, { args: Symbol('not-json') }),
      ).rejects.toThrow(/Workflow args must be JSON-serializable/i);
    }),
  );

  it.live('rejects malformed args JSON while installing the bridge', () =>
    Effect.gen(function* () {
      yield* expectEffect(
        fromPromise(() =>
          runScriptInSandbox(`return args`, sandboxBridge({ argsJson: '{' }), {
            filename: 'malformed-args.workflow.js',
            timeoutMs: 1_000,
          }),
        ),
      ).rejects.toThrow(/expecting property name|JSON|unexpected end/i);
    }),
  );

  it.live('aborts parallel siblings when one continuation runs forever', () =>
    Effect.gen(function* () {
      const runner = () => Effect.never;

      yield* expectEffect(
        runScript(
          `
return await parallel([
  () => agent('waiting-sibling'),
  async () => { await Promise.resolve(); while (true) {} },
])`,
          { runAgent: runner, timeoutMs: 40 },
        ),
      ).rejects.toThrow(/timed out/);
    }),
  );

  // Containment is proven by the /memory/ rejection alone: had the runtime's
  // memory limit not tripped, the 2s engine timeout would have rejected with
  // /timed out/ instead.
  //
  // There is deliberately no wall-clock assertion. One used to guard against the
  // allocation loop wedging the host, but filling the guest heap 1 MB at a time
  // took 78s during a full-suite run on a contended machine, so any bound tight
  // enough to mean something is a bound this test trips over. The per-test
  // timeout below is the hang guard, and it needs to be explicit because it
  // exceeds the suite-wide `testTimeout: 10000` in vitest.config.mjs.
  it.live(
    'contains guest memory exhaustion inside the QuickJS runtime',
    () =>
      Effect.gen(function* () {
        yield* expectEffect(
          runScript(
            `
const values = []
while (true) values.push(new Uint8Array(1024 * 1024))`,
            { timeoutMs: 2_000 },
          ),
        ).rejects.toThrow(/memory/i);
      }),
    150_000,
  );

  it.effect('aborts in-flight agents when the call cap trips', () =>
    Effect.gen(function* () {
      let sawAbort = false;
      const runner = (invocation: WorkflowAgentInvocation) =>
        Effect.gen(function* () {
          invocation.signal.addEventListener('abort', () => {
            sawAbort = true;
          });
          yield* sleep(30);
          return invocation.prompt;
        });
      yield* expectEffect(
        runScript(
          `
return await parallel([1, 2, 3, 4, 5].map((n) => () => agent('call-' + n)))`,
          { runAgent: runner, maxAgentCalls: 3 },
        ),
      ).rejects.toThrow(/agent-call cap/);
      expect(sawAbort).toBe(true);
    }),
  );

  it.effect(
    'blocks caller-chain escapes from sloppy-mode thunks (strict scripts)',
    () =>
      Effect.gen(function* () {
        // Thunks run realm-side and sandbox bodies are forced into strict mode,
        // so arguments.callee.caller is unavailable even without this guard —
        // this covers non-strict callables a script might still construct.
        const run = yield* runScript(`
return await parallel([function () {
  try {
    return arguments.callee.caller.constructor('return typeof process')()
  } catch {
    return 'blocked'
  }
}])`);
        expect(run.result).toEqual(['blocked']);
      }),
  );

  it.effect('stops the workflow when a runner surfaces the run abort', () =>
    Effect.gen(function* () {
      const snapshots: WorkflowScriptRunResult['snapshot'][] = [];
      const runner = (invocation: WorkflowAgentInvocation) => {
        invocation.report({ model: 'abort-model' });
        const abortError = new Error('runner observed abort');
        abortError.name = 'WorkflowRunAbortError';
        return Effect.fail(abortError);
      };
      yield* expectEffect(
        runScript(
          `
return await parallel([() => agent('x')])`,
          {
            runAgent: runner,
            onSnapshot: (snapshot) =>
              Effect.sync(() => {
                snapshots.push(snapshot);
              }),
          },
        ),
      ).rejects.toThrow(/runner observed abort/);
      expect(snapshots.at(-1)?.calls).toMatchObject([
        {
          id: 'call-0',
          label: 'x',
          status: 'failed',
          error: 'runner observed abort',
          model: 'abort-model',
        },
      ]);
    }),
  );

  it.effect('does not let script code suppress a fatal runner abort', () =>
    Effect.gen(function* () {
      const runner = () => {
        const abortError = new Error('durable manifest unavailable');
        abortError.name = 'WorkflowRunAbortError';
        return Effect.fail(abortError);
      };

      yield* expectEffect(
        runScript(
          `
try {
  await agent('x')
} catch {}
return 'incorrect success'`,
          { runAgent: runner },
        ),
      ).rejects.toMatchObject({
        name: 'WorkflowRunAbortError',
        message: 'durable manifest unavailable',
      });
    }),
  );

  it.effect('promotes an abort surfaced by name to a typed run fault', () =>
    Effect.gen(function* () {
      // Runner-minted aborts and realm copies are not instances, so the name is
      // what classifies them; the run then reports its own typed reason.
      const surfaced = new Error('durable manifest unavailable');
      surfaced.name = 'WorkflowRunAbortError';
      expect(surfaced).not.toBeInstanceOf(WorkflowRunAbortError);

      const fault = yield* runScript(`return await agent('x')`, {
        runAgent: () => Effect.fail(surfaced),
      }).pipe(Effect.flip);

      expect(fault).toBeInstanceOf(WorkflowRunAbortError);
      expect(fault).toMatchObject({
        kind: 'runner',
        message: 'durable manifest unavailable',
        cause: surfaced,
      });
    }),
  );

  it.live(
    'reports the timeout, not the queued call the timeout cancelled',
    () =>
      Effect.gen(function* () {
        const snapshots: WorkflowScriptRunResult['snapshot'][] = [];
        yield* expectEffect(
          runScript(
            `
return await parallel([() => agent('running'), () => agent('queued')])`,
            {
              concurrency: 1,
              timeoutMs: 40,
              runAgent: (invocation: WorkflowAgentInvocation) =>
                Effect.gen(function* () {
                  yield* sleep(200);
                  return invocation.prompt;
                }),
              onSnapshot: (snapshot) =>
                Effect.sync(() => {
                  snapshots.push(snapshot);
                }),
            },
          ),
        ).rejects.toThrow(/timed out/);
        // The call that reached its queue slot after the timeout fails with the
        // reason that stopped the run, and that reason does not outrank the
        // sandbox's timeout error.
        expect(
          snapshots.at(-1)?.calls.find((call) => call.label === 'queued'),
        ).toMatchObject({
          status: 'failed',
          error: expect.stringContaining('timed out'),
        });
      }),
  );

  it.effect('aborts guest run and the active child from a parent signal', () =>
    Effect.gen(function* () {
      const controller = new AbortController();
      let childSignal: AbortSignal | undefined;
      const runFiber = yield* runWorkflowScript({
        script: `${META}return await agent('wait')`,
        signal: controller.signal,
        runAgent: (invocation) => {
          childSignal = invocation.signal;
          return controlledEffect<unknown>((_resolve, reject) => {
            invocation.signal.addEventListener(
              'abort',
              () => reject(invocation.signal.reason),
              { once: true },
            );
          });
        },
      }).pipe(Effect.forkChild);
      yield* waitFor(() => expect(childSignal).toBeDefined());

      controller.abort(new DOMException('parent stopped', 'AbortError'));

      yield* expectEffect(Fiber.join(runFiber)).rejects.toMatchObject({
        name: 'AbortError',
        message: 'parent stopped',
      });
      expect(childSignal?.aborted).toBe(true);
    }),
  );

  it.effect(
    'skip(childRunId) skips only that call: SKIPPED result, no journal, siblings finish',
    () =>
      Effect.gen(function* () {
        const started = new Set<number>();
        const release = new Map<number, () => void>();
        let control!: WorkflowScriptControl;
        const runner = (invocation: WorkflowAgentInvocation) =>
          controlledEffect<string>((resolve, reject) => {
            started.add(invocation.index);
            invocation.report({
              model: 'skip-model',
              childRunId: childRunIdFor(invocation.index),
            });
            release.set(invocation.index, () =>
              resolve(`done:${invocation.index}`),
            );
            rejectOnAbort(invocation, reject);
          });

        const runFiber = yield* runWorkflowScript({
          script: `${META}return await parallel([
  () => agent('a', { id: 'a' }),
  () => agent('b', { id: 'b' }),
  () => agent('c', { id: 'c' }),
])`,
          runAgent: runner,
          concurrency: 3,
          onControl: (handle) => {
            control = handle;
          },
        }).pipe(Effect.forkChild);

        yield* waitFor(() => expect(started.size).toBe(3));
        control(childRunIdFor(1), 'skip');
        // Siblings settle normally; only index 1 is cancelled.
        release.get(0)?.();
        release.get(2)?.();

        const run = yield* Fiber.join(runFiber);
        const result = run.result as string[];
        expect(result[0]).toBe('done:0');
        expect(result[1]).toBe(WORKFLOW_SKIPPED_RESULT);
        expect(result[2]).toBe('done:2');
        // Skipped call is NOT journaled (resume re-runs it); siblings are.
        expect(run.journal.map((entry) => entry.index).toSorted()).toEqual([
          0, 2,
        ]);
        expect(run.snapshot.calls).toMatchObject([
          { id: 'a', status: 'completed' },
          { id: 'b', label: 'b', status: 'skipped', model: 'skip-model' },
          { id: 'c', status: 'completed' },
        ]);
      }),
  );

  it.effect(
    'makes a call controllable the moment its child id is reported',
    () =>
      Effect.gen(function* () {
        // Control is keyed by the child id the runner reports, so the earliest a
        // host can target an attempt is the instant that id exists — which is
        // still early enough to cancel the attempt before it produces a result.
        let control!: WorkflowScriptControl;
        const runner = vi.fn((invocation: WorkflowAgentInvocation) =>
          controlledEffect<string>((_resolve, reject) => {
            rejectOnAbort(invocation, reject);
            invocation.report({
              childRunId: childRunIdFor(invocation.index),
            });
            control(childRunIdFor(invocation.index), 'skip');
          }),
        );
        const run = yield* runWorkflowScript({
          script: `${META}return await agent('skip immediately')`,
          runAgent: runner,
          onControl: (handle) => {
            control = handle;
          },
        });

        expect(run.result).toBe(WORKFLOW_SKIPPED_RESULT);
        expect(run.journal).toEqual([]);
        expect(runner).toHaveBeenCalledTimes(1);
      }),
  );

  it.effect(
    'retry(childRunId) re-runs a single in-flight call and yields the new result',
    () =>
      Effect.gen(function* () {
        const attemptByIndex = new Map<number, number>();
        const releases: Array<() => void> = [];
        let control!: WorkflowScriptControl;
        const runner = (invocation: WorkflowAgentInvocation) =>
          controlledEffect<string>((resolve, reject) => {
            const attempt = (attemptByIndex.get(invocation.index) ?? 0) + 1;
            attemptByIndex.set(invocation.index, attempt);
            invocation.report({
              childRunId: childRunIdFor(invocation.index, attempt),
            });
            releases.push(() => resolve(`attempt-${attempt}`));
            rejectOnAbort(invocation, reject);
          });

        const runFiber = yield* runWorkflowScript({
          script: `${META}return await agent('go')`,
          runAgent: runner,
          onControl: (handle) => {
            control = handle;
          },
        }).pipe(Effect.forkChild);

        yield* waitFor(() => expect(attemptByIndex.get(0)).toBe(1));
        control(childRunIdFor(0, 1), 'retry');
        // The aborted first attempt is discarded; a fresh attempt starts.
        yield* waitFor(() => expect(attemptByIndex.get(0)).toBe(2));
        releases.at(-1)?.();

        const run = yield* Fiber.join(runFiber);
        expect(run.result).toBe('attempt-2');
        // Journaled exactly once, with the new attempt's result (no double-journal).
        expect(run.journal).toEqual([
          {
            index: 0,
            key: expect.any(String),
            result: 'attempt-2',
          },
        ]);
      }),
  );

  it.effect(
    'forgets an abandoned attempt id so a stale request cannot skip its successor',
    () =>
      Effect.gen(function* () {
        const attemptByIndex = new Map<number, number>();
        const releases: Array<() => void> = [];
        let control!: WorkflowScriptControl;
        const runner = (invocation: WorkflowAgentInvocation) =>
          controlledEffect<string>((resolve, reject) => {
            rejectOnAbort(invocation, reject);
            const attempt = (attemptByIndex.get(invocation.index) ?? 0) + 1;
            attemptByIndex.set(invocation.index, attempt);
            invocation.report({
              childRunId: childRunIdFor(invocation.index, attempt),
            });
            releases.push(() => resolve(`attempt-${attempt}`));
          });

        const runFiber = yield* runWorkflowScript({
          script: `${META}return await agent('go')`,
          runAgent: runner,
          onControl: (handle) => {
            control = handle;
          },
        }).pipe(Effect.forkChild);

        yield* waitFor(() => expect(attemptByIndex.get(0)).toBe(1));
        control(childRunIdFor(0, 1), 'retry');
        yield* waitFor(() => expect(attemptByIndex.get(0)).toBe(2));
        // The retried attempt runs under a new id; the abandoned one is dead and
        // must not reach the fresh attempt that now owns the call.
        control(childRunIdFor(0, 1), 'skip');
        releases.at(-1)?.();

        const run = yield* Fiber.join(runFiber);
        expect(run.result).toBe('attempt-2');
      }),
  );

  it.effect('never registers a recovered child id as a skip/retry target', () =>
    Effect.gen(function* () {
      let control!: WorkflowScriptControl;
      let releaseCall!: () => void;
      const recoveredId = childRunIdFor(0, 1);
      const runner = (invocation: WorkflowAgentInvocation) =>
        controlledEffect<string>((resolve, reject) => {
          rejectOnAbort(invocation, reject);
          // A durable-recovery runner re-attaches the known child id for
          // navigation, then keeps resolving asynchronously (readMeta gap).
          invocation.report({
            childRunId: recoveredId,
            recovered: true,
          });
          releaseCall = () => resolve('recovered-result');
        });

      const runFiber = yield* runWorkflowScript({
        script: `${META}return await agent('go')`,
        runAgent: runner,
        onControl: (handle) => {
          control = handle;
        },
      }).pipe(Effect.forkChild);

      yield* waitFor(() => expect(releaseCall).toBeDefined());
      // The skip lands inside the recovery window; a recovered result is
      // authoritative, so the request must no-op instead of discarding it.
      control(recoveredId, 'skip');
      releaseCall();

      const run = yield* Fiber.join(runFiber);
      expect(run.result).toBe('recovered-result');
    }),
  );

  it.effect(
    'keeps a journaled completed call completed when a transition observer throws',
    () =>
      Effect.gen(function* () {
        const journaled: number[] = [];
        const snapshots: WorkflowScriptRunResult['snapshot'][] = [];
        let exploded = false;
        const runFiber = yield* runWorkflowScript({
          script: `${META}return await agent('go')`,
          runAgent: () => Effect.succeed('done'),
          onJournalEntry: (entry) =>
            Effect.sync(() => {
              journaled.push(entry.index);
            }),
          onSnapshot: (snapshot) =>
            Effect.sync(() => {
              snapshots.push(snapshot);
            }),
          onTransition: (snapshot) => {
            // The call is already journaled when it first transitions to
            // COMPLETED; a throwing host observer must not rewrite it.
            if (exploded || snapshot.calls[0]?.status !== 'completed') return;
            exploded = true;
            throw new Error('host transition observer exploded');
          },
        }).pipe(Effect.forkChild);

        yield* expectEffect(Fiber.join(runFiber)).rejects.toThrow(
          'host transition observer exploded',
        );
        expect(journaled).toEqual([0]);
        expect(snapshots.at(-1)?.calls[0]).toMatchObject({
          status: 'completed',
        });
      }),
  );

  it.effect('charges every retry attempt against the live-call cap', () =>
    Effect.gen(function* () {
      let control!: WorkflowScriptControl;
      const snapshots: WorkflowScriptRunResult['snapshot'][] = [];
      let attempts = 0;
      const runner = vi.fn((invocation: WorkflowAgentInvocation) => {
        attempts += 1;
        invocation.report({
          model: 'retry-model',
          childRunId: childRunIdFor(invocation.index, attempts),
        });
        return controlledEffect<never>((_resolve, reject) => {
          rejectOnAbort(invocation, reject);
        });
      });
      const runFiber = yield* runWorkflowScript({
        script: `${META}return await agent('retry until refused')`,
        runAgent: runner,
        maxAgentCalls: 2,
        onControl: (handle) => {
          control = handle;
        },
        onSnapshot: (snapshot) =>
          Effect.sync(() => {
            snapshots.push(snapshot);
          }),
      }).pipe(Effect.forkChild);

      yield* waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
      control(childRunIdFor(0, 1), 'retry');
      yield* waitFor(() => expect(runner).toHaveBeenCalledTimes(2));
      control(childRunIdFor(0, 2), 'retry');

      yield* expectEffect(Fiber.join(runFiber)).rejects.toThrow(
        /agent-call cap/,
      );
      expect(runner).toHaveBeenCalledTimes(2);
      // Both physical attempts were charged, and the third never launched: the
      // one logical call settles failed with the cap as its cause.
      expect(snapshots.at(-1)?.calls).toMatchObject([
        {
          id: 'call-0',
          status: 'failed',
          error: expect.stringContaining('agent-call cap'),
          attempts: [
            { number: 1, model: 'retry-model' },
            { number: 2, model: 'retry-model' },
          ],
        },
      ]);
    }),
  );

  it.effect(
    'a whole-run abort cascades to every in-flight per-call controller',
    () =>
      Effect.gen(function* () {
        const started = new Set<number>();
        const aborted = new Set<number>();
        const parent = new AbortController();
        const runner = (invocation: WorkflowAgentInvocation) =>
          controlledEffect<string>((_resolve, reject) => {
            started.add(invocation.index);
            invocation.signal.addEventListener(
              'abort',
              () => {
                aborted.add(invocation.index);
                reject(new Error('aborted'));
              },
              { once: true },
            );
          });

        const runFiber = yield* runScript(
          `return await parallel([
  () => agent('a', { id: 'a' }),
  () => agent('b', { id: 'b' }),
])`,
          { runAgent: runner, concurrency: 2, signal: parent.signal },
        ).pipe(Effect.forkChild);

        yield* waitFor(() => expect(started.size).toBe(2));
        parent.abort(new DOMException('parent stopped', 'AbortError'));

        yield* expectEffect(Fiber.join(runFiber)).rejects.toMatchObject({
          name: 'AbortError',
        });
        expect(aborted).toEqual(new Set([0, 1]));
      }),
  );

  it.effect('owns a terminal canonical snapshot with direct-call counts', () =>
    Effect.gen(function* () {
      const snapshots: WorkflowScriptRunResult['snapshot'][] = [];
      const result = yield* runWorkflowScript({
        script: `export const meta = {
  name: 'observable',
  description: 'observable workflow',
  phases: ['Draft', 'Review'],
  tasks: [
    { id: 'draft', label: 'Draft paper', phase: 'Draft' },
    { id: 'review', label: 'Review paper', phase: 'Review' },
  ],
}
phase('Draft')
await agent('draft instruction', { id: 'draft' })
return 'done'`,
        runAgent: (invocation) =>
          Effect.sync(() => {
            // One report carrying every fact the host resolved must land them all.
            invocation.report({
              agent: 'writer',
              model: 'model-a',
              childRunId: 'abcdef123456' as RunId,
            });
            return 'drafted';
          }),
        onSnapshot: (snapshot) =>
          Effect.sync(() => {
            snapshots.push(snapshot);
          }),
      });

      expect(snapshots.length).toBeGreaterThan(0);
      expect(result.snapshot).toMatchObject({
        outcome: 'completed',
        currentStageId: undefined,
        calls: [
          {
            id: 'draft',
            status: 'completed',
            agent: 'writer',
            model: 'model-a',
            childRunId: 'abcdef123456',
            attempts: [{ number: 1, id: 'abcdef123456' }],
          },
          { id: 'review', status: 'skipped' },
        ],
      });
      expect(deriveWorkflowCounts(result.snapshot.calls)).toMatchObject({
        total: result.snapshot.calls.length,
        completed: 1,
        skipped: 1,
      });
    }),
  );

  it.effect('uses safe canonical labels for dynamic calls', () =>
    Effect.gen(function* () {
      const result = yield* runWorkflowScript({
        script: `export const meta = {
  name: 'labels',
  description: 'label workflow',
}
return await agent('secret full instruction', {
  inputFiles: ['/private/host/path/paper.tex'],
  agentName: 'proofreader',
})`,
        fingerprintAgentDependencies: () => Effect.succeed('fingerprint'),
        runAgent: () => Effect.succeed('done'),
      });

      expect(result.snapshot.calls[0]).toMatchObject({
        label: 'paper.tex: proofreader',
        files: { input: ['paper.tex'], context: [], media: [] },
      });
      expect(JSON.stringify(result.snapshot)).not.toContain(
        '/private/host/path',
      );
      expect(JSON.stringify(result.snapshot)).not.toContain(
        'secret full instruction',
      );
    }),
  );

  it.effect(
    'removes Intl so scripts cannot read the wall clock implicitly',
    () =>
      Effect.gen(function* () {
        yield* expectEffect(
          runScript(`return new Intl.DateTimeFormat().format()`),
        ).rejects.toThrow();
      }),
  );
});
