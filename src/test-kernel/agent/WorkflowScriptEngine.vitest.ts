import { describe, expect, it, vi } from 'vitest';

import {
  parseWorkflowScript,
  runWorkflowScript,
  WORKFLOW_SKIPPED_RESULT,
  WorkflowRunAbortError,
  WorkflowScriptParseError,
  type WorkflowAgentInvocation,
  type WorkflowScriptControl,
  type WorkflowScriptEvent,
  type WorkflowScriptRunResult,
} from '@agent/workflowScript';
import { runScriptInSandbox } from '@agent/workflowScript/sandbox';
import { deriveWorkflowCounts, type ExecutionId } from '@shared/schemas';
import { delay } from '@utils/core';

const META = `export const meta = {
  name: 'test-flow',
  description: 'engine test flow',
  phases: [{ title: 'Work' }],
}\n`;

function echoRunner(invocation: WorkflowAgentInvocation): Promise<string> {
  return Promise.resolve(`result:${invocation.prompt}`);
}

/** Captures every invocation while echoing its prompt, for later assertions. */
function collectingRunner(
  invocations: WorkflowAgentInvocation[],
): (invocation: WorkflowAgentInvocation) => Promise<string> {
  return (invocation) => {
    invocations.push(invocation);
    return echoRunner(invocation);
  };
}

/** Runs `body` under the shared META header, echoing prompts by default. */
function runScript(
  body: string,
  overrides: Partial<Parameters<typeof runWorkflowScript>[0]> = {},
): Promise<WorkflowScriptRunResult> {
  return runWorkflowScript({
    script: `${META}${body}`,
    runAgent: echoRunner,
    ...overrides,
  });
}

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
 * The child execution id one attempt runs under. Interactive control is keyed
 * by the id the runner reports, so a fake runner announces one per attempt
 * exactly as the production runner does — and a retry announces a new one.
 */
function childExecutionIdFor(index: number, attempt = 1): ExecutionId {
  return `child-${index}-${attempt}` as ExecutionId;
}

const EMPTY_FILES_JSON = '{"inputFiles":[],"contextFiles":[],"mediaFiles":[]}';

type SandboxBridge = Parameters<typeof runScriptInSandbox>[1];

function sandboxBridge(overrides: Partial<SandboxBridge> = {}): SandboxBridge {
  return {
    asyncFns: {},
    syncFns: {},
    argsJson: undefined,
    filesJson: EMPTY_FILES_JSON,
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
  description: 'declares progress before execution',
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
      WorkflowScriptParseError,
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
  it('uses meta.tasks as the single source for task labels and phases', async () => {
    const events: WorkflowScriptEvent[] = [];
    const runner = vi.fn(echoRunner);
    await runWorkflowScript({
      script: `export const meta = {
  name: 'planned-run',
  description: 'runs a declared plan',
  phases: [{ title: 'Audit' }],
  tasks: [{ id: 'core', label: 'Audit core', phase: 'Audit' }],
}
return await agent('Inspect src', { id: 'core' })`,
      runAgent: runner,
      onEvent: (event) => events.push(event),
    });

    expect(events[0]).toEqual({
      type: 'plan',
      tasks: [{ id: 'core', label: 'Audit core', phase: 'Audit' }],
    });
    expect(runner.mock.calls[0][0].options).toMatchObject({
      id: 'core',
      label: 'Audit core',
      phase: 'Audit',
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent:start',
        progressId: 'core',
        label: 'Audit core',
        phase: 'Audit',
      }),
    );
  });

  it('rejects calls outside a declared plan and conflicting presentation data', async () => {
    const plannedMeta = `export const meta = {
  name: 'strict-plan',
  description: 'requires task references',
  tasks: [{ id: 'known', label: 'Known task' }],
}
`;
    async function expectPlanRejection(
      body: string,
      pattern: RegExp,
    ): Promise<void> {
      await expect(
        runWorkflowScript({
          script: `${plannedMeta}${body}`,
          runAgent: echoRunner,
        }),
      ).rejects.toThrow(pattern);
    }

    await expectPlanRejection(
      `return await agent('missing id')`,
      /must reference a task from meta\.tasks/,
    );
    await expectPlanRejection(
      `return await agent('unknown', { id: 'other' })`,
      /undeclared task id "other"/,
    );
    await expectPlanRejection(
      `return await agent('conflict', {
  id: 'known',
  label: 'Conflicting label',
})`,
      /must use the label and phase declared in meta\.tasks/,
    );
    await expectPlanRejection(
      `return await parallel([
  () => agent('first use', { id: 'known' }),
  () => agent('second use', { id: 'known' }),
])`,
      /may be issued only once per run/i,
    );
  });

  it('accepts task presentation fields that exactly match the plan', async () => {
    const runner = vi.fn(echoRunner);
    await runWorkflowScript({
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
  });

  it('treats an explicitly empty task plan as closed', async () => {
    const emptyPlan = `export const meta = {
  name: 'empty-plan',
  description: 'declares that no agent work is planned',
  tasks: [],
}
`;
    function runEmptyPlan(
      body: string,
      overrides: Partial<Parameters<typeof runWorkflowScript>[0]> = {},
    ): Promise<WorkflowScriptRunResult> {
      return runWorkflowScript({
        script: `${emptyPlan}${body}`,
        runAgent: echoRunner,
        ...overrides,
      });
    }

    await expect(
      runEmptyPlan(`return await agent('undeclared')`),
    ).rejects.toThrow(/Every agent\(\) call must reference a task/);

    const events: WorkflowScriptEvent[] = [];
    const result = await runEmptyPlan(`return 'done'`, {
      onEvent: (event) => events.push(event),
    });
    expect(result.result).toBe('done');
    expect(events).toContainEqual({ type: 'plan', tasks: [] });
  });

  it('runs a script end-to-end with agent calls and args', async () => {
    const runner = vi.fn(echoRunner);
    const run = await runScript(
      `
const a = await agent('alpha')
const b = await agent('beta:' + args.suffix)
return [a, b]`,
      { args: { suffix: 'S' }, runAgent: runner },
    );
    expect(run.result).toEqual(['result:alpha', 'result:beta:S']);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(run.journal).toHaveLength(2);
  });

  it('exposes launch files as immutable script context', async () => {
    const run = await runScript(
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
  });

  it('passes a structured result from agent({ schema }) to the script and keys the journal by schema', async () => {
    const schema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    };
    const keys: string[] = [];
    const run = await runWorkflowScript({
      script: `${META}
const withSchema = await agent('draft', { agentName: 'assistant', schema: args.schema })
const plain = await agent('draft')
return { structured: withSchema.structured, plain }`,
      args: { schema },
      runAgent: (invocation) => {
        keys.push(invocation.key);
        return Promise.resolve(
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
  });

  it('normalizes per-call models and includes them in journal identity', async () => {
    const invocations: WorkflowAgentInvocation[] = [];
    const run = await runWorkflowScript({
      script: `${META}
const routine = await agent('draft', { model: 'economy-model' })
const difficult = await agent('draft', { model: 'strong-model' })
return [routine, difficult]`,
      runAgent: (invocation) => {
        invocations.push(invocation);
        return Promise.resolve(`result:${invocation.options.model}`);
      },
    });

    expect(run.result).toEqual(['result:economy-model', 'result:strong-model']);
    expect(invocations.map(({ options }) => options.model)).toEqual([
      'economy-model',
      'strong-model',
    ]);
    expect(invocations[0]?.key).not.toBe(invocations[1]?.key);
  });

  it('rejects a non-object schema option', async () => {
    await expect(
      runScript(`return await agent('draft', { schema: 'nope' })`),
    ).rejects.toThrow(/schema.*must be a plain JSON Schema object/i);
  });

  it('rejects an empty or regex-bearing structured-output schema', async () => {
    await expect(
      runScript(`return await agent('draft', { schema: {} })`),
    ).rejects.toThrow(/schema.*object-root JSON Schema/i);
    await expect(
      runScript(
        `return await agent('draft', { schema: { type: 'object', properties: { value: { type: 'string', pattern: '(a+)+$' } } } })`,
      ),
    ).rejects.toThrow(/cannot use pattern/i);
  });

  it('requires explicit identities for otherwise-repeated calls', async () => {
    const invocations: WorkflowAgentInvocation[] = [];
    await runWorkflowScript({
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

    await expect(
      runScript(`return await parallel([
  () => agent('first prompt', { id: 'shared-id' }),
  () => agent('second prompt', { id: 'shared-id' }),
])`),
    ).rejects.toThrow(/call id "shared-id" may be issued only once/i);

    await expect(
      runScript(`return await parallel([
  () => agent('same'),
  () => agent('same'),
])`),
    ).rejects.toThrow(/require distinct non-empty "id" options/i);

    await expect(
      runScript(`return await parallel([
  () => agent('same', { id: 'same-id' }),
  () => agent('same', { id: ' same-id ' }),
        ])`),
    ).rejects.toThrow(/call id "same-id" may be issued only once/i);
  });

  it('passes typed workflow outputs into the next stage input files', async () => {
    const outputPath =
      '/storage/executions/bbbbbb222222/r1/drafted-section.tex';
    const invocations: WorkflowAgentInvocation[] = [];
    const run = await runWorkflowScript({
      script: `${META}
const drafted = await agent('draft')
return await agent('merge', {
  inputFiles: drafted.outputs.map((output) => output.absolutePath),
})`,
      runAgent: async (call) => {
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
      },
      fingerprintAgentDependencies: async () => 'drafted-section-v1',
    });

    expect(invocations[1]?.options.inputFiles).toEqual([outputPath]);
    expect(run.result).toMatchObject({
      category: 'workflow',
      outcome: 'completed',
    });
  });

  it('parallel(): surfaces script errors instead of converting them to null', async () => {
    await expect(
      runScript(`
return await parallel([
  () => agent('ok-1'),
  () => { throw new Error('thunk boom') },
  () => agent('ok-2'),
])`),
    ).rejects.toThrow('thunk boom');
  });

  it('parallel(): keeps a thunk error when cleanup aborts queued siblings', async () => {
    const runner = vi.fn(
      (invocation: WorkflowAgentInvocation) =>
        new Promise<never>((_resolve, reject) => {
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

    await expect(
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
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('agent() resolves to null on runner failure and is not journaled', async () => {
    const runner = vi.fn((invocation: WorkflowAgentInvocation) =>
      invocation.prompt === 'boom'
        ? Promise.reject(new Error('runner failed'))
        : echoRunner(invocation),
    );
    const run = await runScript(
      `return [await agent('boom'), await agent('fine')]`,
      { runAgent: runner },
    );
    expect(run.result).toEqual([null, 'result:fine']);
    // Only the successful call is journaled, so a resume retries the failure.
    expect(run.journal.map((entry) => entry.index)).toEqual([1]);
  });

  it('awaits durable journal hooks and excludes failed calls from them', async () => {
    const order: string[] = [];
    const run = await runWorkflowScript({
      script: `${META}return [await agent('boom'), await agent('saved')]`,
      runAgent: async ({ prompt }) => {
        if (prompt === 'boom') throw new Error('runner failed');
        order.push('runner');
        return 'saved result';
      },
      onJournalEntry: async (entry) => {
        await delay(5);
        order.push(`checkpoint:${entry.index}`);
      },
      onEvent: (event) => {
        if (event.type === 'agent:end' && event.outcome !== 'failed') {
          order.push(`end:${event.index}`);
        }
      },
    });

    expect(run.result).toEqual([null, 'saved result']);
    expect(order).toEqual(['runner', 'checkpoint:1', 'end:1']);
  });

  it('surfaces a late checkpoint failure from an abandoned agent call', async () => {
    const events: WorkflowScriptEvent[] = [];
    await expect(
      runWorkflowScript({
        script: `${META}agent('abandoned', { phase: 'Work' }); return 'guest success'`,
        runAgent: async (invocation) => {
          invocation.report?.({ model: 'checkpoint-model' });
          await delay(5);
          return 'completed child';
        },
        onJournalEntry: async () => {
          await delay(5);
          throw new Error('checkpoint offline');
        },
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({ name: 'WorkflowRunAbortError' });
    expect(events.at(-1)).toMatchObject({
      type: 'agent:end',
      phase: 'Work',
      phaseIndex: 0,
      phaseTotal: 1,
      error: expect.stringContaining('checkpoint offline'),
      model: 'checkpoint-model',
      durationMs: expect.any(Number),
    });
    expect(events.filter((event) => event.type === 'agent:end')).toHaveLength(
      1,
    );
  });

  it('does not let a guest error mask a late checkpoint failure', async () => {
    await expect(
      runWorkflowScript({
        script: `${META}agent('abandoned'); throw new Error('guest failed')`,
        runAgent: async () => {
          await delay(5);
          return 'completed child';
        },
        onJournalEntry: async () => {
          await delay(5);
          throw new Error('checkpoint offline');
        },
      }),
    ).rejects.toMatchObject({
      name: 'WorkflowRunAbortError',
      message: expect.stringContaining('checkpoint offline'),
    });
  });

  it('caps concurrent agent() calls to the p-queue concurrency limit over a large fan-out', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let completed = 0;
    const runner = async (invocation: WorkflowAgentInvocation) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Wide margin over the queue-add loop: the first `concurrency` runners
      // must all start before any of them settles, so saturation is
      // deterministic even under CI scheduler pressure.
      await delay(10);
      inFlight -= 1;
      completed += 1;
      return invocation.prompt;
    };
    const run = await runScript(
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
  });

  it('replays matching journal entries and re-runs edited calls', async () => {
    const script = `${META}
const a = await agent('stage-a')
const b = await agent('stage-b:' + a)
return b`;
    const first = await runWorkflowScript({ script, runAgent: echoRunner });
    expect(first.result).toBe('result:stage-b:result:stage-a');

    // Unchanged script: full cache hit, runner never called.
    const cachedRunner = vi.fn(echoRunner);
    const second = await runWorkflowScript({
      script,
      runAgent: cachedRunner,
      journal: first.journal,
    });
    expect(second.result).toBe(first.result);
    expect(cachedRunner).not.toHaveBeenCalled();

    // Edited second call: first replays from cache, second runs live.
    const editedRunner = vi.fn(echoRunner);
    const edited = await runScript(
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
  });

  it('keeps resume identity stable when planned presentation changes', async () => {
    const first = await runWorkflowScript({
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
    const events: WorkflowScriptEvent[] = [];

    const resumed = await runWorkflowScript({
      script: `export const meta = {
  name: 'planned-resume',
  description: 'revised presentation',
  phases: [{ title: 'Audit' }],
  tasks: [{ id: 'inspect', label: 'Audit implementation', phase: 'Audit' }],
}
return await agent('Inspect src', { id: 'inspect' })`,
      runAgent: cachedRunner,
      journal: first.journal,
      onEvent: (event) => events.push(event),
    });

    expect(resumed.result).toBe(first.result);
    expect(cachedRunner).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      type: 'agent:end',
      progressId: 'inspect',
      index: 0,
      label: 'Audit implementation',
      phase: 'Audit',
      phaseIndex: 0,
      phaseTotal: 1,
      outcome: 'cached',
    });
  });

  it('invalidates cached calls when referenced file contents change', async () => {
    const script = `${META}return await agent('review', {
  inputFiles: ['proof.tex'],
})`;
    let dependencyFingerprint = 'old-proof';
    const first = await runWorkflowScript({
      script,
      runAgent: async () => 'old result',
      fingerprintAgentDependencies: async () => dependencyFingerprint,
    });
    const runner = vi.fn(async () => 'new result');

    dependencyFingerprint = 'new-proof';
    const resumed = await runWorkflowScript({
      script,
      runAgent: runner,
      journal: first.journal,
      fingerprintAgentDependencies: async () => dependencyFingerprint,
    });

    expect(resumed.result).toBe('new result');
    expect(runner).toHaveBeenCalledOnce();
    expect(resumed.journal[0]?.key).not.toBe(first.journal[0]?.key);
  });

  it('replays file-backed calls only when their dependency fingerprint matches', async () => {
    const script = `${META}return await agent('review', {
  inputFiles: ['proof.tex'],
})`;
    const fingerprintAgentDependencies = async () => 'same-proof';
    const first = await runWorkflowScript({
      script,
      runAgent: async () => 'saved result',
      fingerprintAgentDependencies,
    });
    const runner = vi.fn(async () => 'must not run');

    const resumed = await runWorkflowScript({
      script,
      runAgent: runner,
      journal: first.journal,
      fingerprintAgentDependencies,
    });

    expect(resumed.result).toBe('saved result');
    expect(runner).not.toHaveBeenCalled();
  });

  it('requires hosts to fingerprint file-backed calls', async () => {
    await expect(
      runScript(`return await agent('review', {
  inputFiles: ['proof.tex'],
})`),
    ).rejects.toThrow(/must fingerprint agent\(\) file dependencies/);
  });

  it('rejects an empty host fingerprint for file-backed calls', async () => {
    await expect(
      runScript(
        `return await agent('review', {
  inputFiles: ['proof.tex'],
})`,
        { fingerprintAgentDependencies: async () => undefined as never },
      ),
    ).rejects.toThrow(/returned no fingerprint/);
  });

  it('makes initial dependency fingerprint failures run-fatal', async () => {
    const fingerprintError = new Error('proof.tex became unreadable');
    const runner = vi.fn(echoRunner);

    await expect(
      runWorkflowScript({
        script: `${META}return await agent('review', {
  inputFiles: ['proof.tex'],
})`,
        runAgent: runner,
        fingerprintAgentDependencies: async () => {
          throw fingerprintError;
        },
      }),
    ).rejects.toMatchObject({
      name: 'WorkflowRunAbortError',
      message: expect.stringContaining(fingerprintError.message),
      cause: fingerprintError,
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it('refreshes file identity after waiting in the concurrency queue', async () => {
    const script = `${META}return await parallel([
  () => agent('blocker', { id: 'blocker' }),
  () => agent('review', { id: 'review', inputFiles: ['proof.tex'] }),
])`;
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let fingerprint = 'old-proof';
    const invocations: WorkflowAgentInvocation[] = [];
    const runPromise = runWorkflowScript({
      script,
      concurrency: 1,
      fingerprintAgentDependencies: async () => fingerprint,
      runAgent: async (invocation) => {
        invocations.push(invocation);
        if (invocation.options.id === 'blocker') await firstBlocked;
        return invocation.options.id;
      },
    });

    await vi.waitFor(() => expect(invocations).toHaveLength(1));
    fingerprint = 'new-proof';
    releaseFirst();
    const run = await runPromise;

    // The refresh is observable as the journal key it re-keys: against a
    // baseline run whose bytes never changed, only the file-backed call's
    // identity moves.
    const baseline = await runWorkflowScript({
      script,
      concurrency: 1,
      fingerprintAgentDependencies: async () => 'old-proof',
      runAgent: async (invocation) => invocation.options.id,
    });
    expect(run.journal[0]?.key).toBe(baseline.journal[0]?.key);
    expect(run.journal[1]?.key).not.toBe(baseline.journal[1]?.key);
  });

  it('refreshes file identity before an interactive retry', async () => {
    let control!: WorkflowScriptControl;
    let fingerprint = 'old-proof';
    const invocations: WorkflowAgentInvocation[] = [];
    const runner = (invocation: WorkflowAgentInvocation) =>
      new Promise<string>((resolve, reject) => {
        invocations.push(invocation);
        invocation.report?.({
          childExecutionId: childExecutionIdFor(
            invocation.index,
            invocations.length,
          ),
        });
        if (invocations.length === 2) resolve('fresh result');
        rejectOnAbort(invocation, reject);
      });
    const runPromise = runWorkflowScript({
      script: `${META}return await agent('review', {
  inputFiles: ['proof.tex'],
})`,
      runAgent: runner,
      fingerprintAgentDependencies: async () => fingerprint,
      onControl: (handle) => {
        control = handle;
      },
    });

    await vi.waitFor(() => expect(invocations).toHaveLength(1));
    const firstKey = invocations[0]?.key;
    fingerprint = 'new-proof';
    control(childExecutionIdFor(0), 'retry');
    const run = await runPromise;

    expect(invocations[1]?.key).not.toBe(firstKey);
    expect(run.journal[0]?.key).toBe(invocations[1]?.key);
  });

  it('ends a cached call with an error when its journal value is invalid', async () => {
    const script = `${META}return await agent('cached')`;
    const first = await runWorkflowScript({ script, runAgent: echoRunner });
    const events: WorkflowScriptEvent[] = [];
    const runner = vi.fn(echoRunner);

    await expect(
      runWorkflowScript({
        script,
        runAgent: runner,
        journal: [{ ...first.journal[0], result: () => undefined }],
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow(/Cached agent\(\) result must be JSON-serializable/i);

    expect(runner).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        type: 'agent:end',
        progressId: 'call-0',
        index: 0,
        label: 'cached',
        phase: undefined,
        outcome: 'failed',
        error: expect.stringMatching(/must be JSON-serializable/i),
      },
    ]);
  });

  it('blocks Date.now() and Math.random() inside scripts', async () => {
    await expect(runScript(`return Date.now()`)).rejects.toThrow(
      /Date\.now\(\) is unavailable/,
    );
    await expect(runScript(`return Math.random()`)).rejects.toThrow(
      /Math\.random\(\) is unavailable/,
    );
  });

  it('enforces the lifetime agent-call cap', async () => {
    await expect(
      runScript(
        `
for (let i = 0; i < 10; i++) await agent('call-' + i)
return 'done'`,
        { maxAgentCalls: 3 },
      ),
    ).rejects.toThrow(/agent-call cap/);
  });

  it('journal replays do not consume the live agent-call cap', async () => {
    const script = `${META}
const a = await agent('one')
const b = await agent('two')
return [a, b]`;
    const first = await runWorkflowScript({ script, runAgent: echoRunner });
    expect(first.journal).toHaveLength(2);

    // Resume with both calls cached plus one new live call, under a cap
    // that the total call count exceeds but the live count does not.
    const liveRunner = vi.fn(echoRunner);
    const resumed = await runWorkflowScript({
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
  });

  it('defaults agent phase to the active phase() and emits events', async () => {
    const invocations: WorkflowAgentInvocation[] = [];
    const events: WorkflowScriptEvent[] = [];
    await runWorkflowScript({
      script: `${META}
phase('Work')
await agent('inside', { label: 'labelled' })
return null`,
      runAgent: collectingRunner(invocations),
      onEvent: (event) => events.push(event),
    });
    expect(invocations[0].options.phase).toBe('Work');
    expect(events).toContainEqual({
      type: 'phase',
      title: 'Work',
      index: 0,
      total: 1,
    });
    expect(events).toContainEqual({
      type: 'agent:start',
      progressId: 'call-0',
      index: 0,
      label: 'labelled',
      phase: 'Work',
      phaseIndex: 0,
      phaseTotal: 1,
    });
  });

  it('normalizes executable phase titles to the declared metadata title', async () => {
    const invocations: WorkflowAgentInvocation[] = [];
    const events: WorkflowScriptEvent[] = [];
    await runWorkflowScript({
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
      onEvent: (event) => events.push(event),
    });

    expect(invocations.map((invocation) => invocation.options.phase)).toEqual([
      'Work',
      'Work',
    ]);
    expect(events).toContainEqual({
      type: 'phase',
      title: 'Work',
      index: 0,
      total: 1,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent:start',
        label: 'Early',
        phase: 'Work',
        phaseIndex: 0,
        phaseTotal: 1,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent:start',
        label: 'Active',
        phase: 'Work',
        phaseIndex: 0,
        phaseTotal: 1,
      }),
    );
  });

  it('rejects invalid primitive usage with clear errors', async () => {
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
      await expect(runScript(body)).rejects.toThrow(pattern);
    }
  });

  it('separates workflow file options from structured tool-use calls', async () => {
    await expect(
      runScript(`return await agent('x', {
  agentName: 'assistant',
  schema: { type: 'object' },
  contextFiles: ['notes.tex'],
})`),
    ).rejects.toThrow(/structured-output calls cannot use file options/);
    await expect(
      runScript(`return await agent('x', {
  schema: { type: 'object' },
})`),
    ).rejects.toThrow(/must name a tool-use agent/);
  });

  it('does not let fan-out swallow invalid structured-call declarations', async () => {
    await expect(
      runScript(`return await parallel([
  () => agent('x', { schema: { type: 'object' } }),
])`),
    ).rejects.toMatchObject({
      name: 'WorkflowRunAbortError',
      message: expect.stringContaining('must name a tool-use agent'),
    });
  });

  it('accepts a schema option and rejects obsolete or misspelled options', async () => {
    const seen: WorkflowAgentInvocation[] = [];
    const runner = collectingRunner(seen);
    await runScript(
      `
return await agent('a', { agentName: 'assistant', schema: { type: 'object' } })`,
      { runAgent: runner },
    );

    expect(seen[0]?.options.schema).toMatchObject({
      type: 'object',
      properties: {},
    });
    await expect(
      runScript(
        `return await agent('b', {
  outputSchema: { type: 'object' },
})`,
        { runAgent: runner },
      ),
    ).rejects.toThrow(/option "outputSchema" is not recognized/);
  });

  it('normalizes agent() options without synthesizing journal-key fields', async () => {
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

    await runScript(
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
        fingerprintAgentDependencies: async () => 'draft-v1',
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
  });

  it('blocks Function-constructor escapes through injected primitives', async () => {
    // agent is a realm-local wrapper, so its .constructor is the sandbox's
    // codeGeneration-gated (Async)Function — compiling from strings throws.
    await expect(
      runScript(`return agent.constructor('return process')()`),
    ).rejects.toThrow(/disallowed/i);
  });

  it('does not leak a host Function via a callback passed to parallel()', async () => {
    // parallel runs realm-side, so the thunk a script hands it is only ever
    // invoked by sandbox code: its `this`/args and any
    // .constructor it can reach are realm-local and codegen-gated. A host
    // callback would carry the ungated host Function constructor.
    const run = await runScript(`
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
  });

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

  it('keeps resolve callbacks realm-local for a malicious thenable', async () => {
    // parallel() awaits thunk results realm-side, so a hand-rolled thenable
    // receives a realm-created resolve callback — its .constructor is the
    // sandbox's codegen-gated Function, so the escape attempt throws and
    // the thenable can only resolve with data.
    const run = await runScript(`
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
  });

  it('reports an unserializable return value as an error, not a timeout', async () => {
    // A BigInt (or circular object) cannot be JSON-encoded; the realm-side
    // deliver must route that through the error path immediately instead of
    // throwing and leaving the host promise to hang until the wall clock.
    await expect(runScript(`return 1n`, { timeoutMs: 5_000 })).rejects.toThrow(
      /not JSON-serializable/i,
    );
  });

  it('carries guest stack frames on script errors', async () => {
    // The classic un-awaited fan-out mistake: destructuring the Promise that
    // parallel() returns. The bare QuickJS message ("value is not iterable")
    // is useless without the frame locating it inside the script.
    await expect(
      runScript(
        `
const [a, b] = parallel([() => agent('x'), () => agent('y')])
return a`,
        { timeoutMs: 5_000 },
      ),
    ).rejects.toThrow(/is not iterable[\s\S]*at .*test-flow\.workflow\.js:\d+/);
  });

  it('cannot forge a result by overriding Promise.prototype.then', async () => {
    // then/catch/finally are locked non-writable before the body runs, so a
    // script that tries to reassign then (to invoke the kickoff's delivery
    // callback with a forged value) gets a real result — the reassignment
    // throws under strict mode, or is simply ignored — not a forged success.
    const run = await runScript(`
try {
  Promise.prototype.then = function () { return this }
} catch (error) {
  // strict-mode assignment to a non-writable property throws; swallow it
}
return 'real-result'`);
    expect(run.result).toBe('real-result');
  });

  it('does not expose the result delivery channel to scripts', async () => {
    // The kickoff captures and deletes __wfDeliver/__wfBody before the body
    // runs, so a script cannot forge an early result through them.
    const run = await runScript(`
return [typeof globalThis.__wfDeliver, typeof globalThis.__wfBody]`);
    expect(run.result).toEqual(['undefined', 'undefined']);
  });

  it('keeps a delivered result when a later guest microtask throws', async () => {
    const run = await runScript(`
Promise.resolve().then(() => {
  Promise.resolve().then(() => { throw new Error('late rejection') })
})
return 'delivered'`);

    expect(run.result).toBe('delivered');
  });

  it('does not time out a delivered result while preempting leftover work', async () => {
    const onTimeout = vi.fn();
    const result = await runScriptInSandbox(
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
    );

    expect(result).toBe('delivered');
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('aborts un-awaited agent() calls left pending when the script returns', async () => {
    // A script that fires an agent() call without awaiting it, then returns,
    // must not leave model work running past the reported-complete point:
    // the unconditional post-run abort fires the call's signal.
    let sawAbort = false;
    const runner = (invocation: WorkflowAgentInvocation) =>
      new Promise<string>((resolve) => {
        invocation.signal.addEventListener('abort', () => {
          sawAbort = true;
          resolve('aborted');
        });
      });
    const run = await runScript(
      `
agent('detached')
return 'done'`,
      { runAgent: runner },
    );
    expect(run.result).toBe('done');
    expect(sawAbort).toBe(true);
  });

  it('gives scripts realm-local agent results, not host objects', async () => {
    const runner = () => Promise.resolve({ nested: { data: 42 } });
    const run = await runScript(
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
  });

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

  it('keeps determinism guards non-writable and blocks argless new Date()', async () => {
    // Strict mode makes assignment to the non-writable guard throw outright.
    await expect(
      runScript(`
Math.random = () => 0.5
return Math.random()`),
    ).rejects.toThrow(/read.?only|unavailable/i);
    await expect(runScript(`return new Date()`)).rejects.toThrow(
      /new Date\(\) without arguments/,
    );
    const explicit = await runScript(`return new Date(0).getTime()`);
    expect(explicit.result).toBe(0);
    // Date.prototype.constructor is locked too, so a script cannot reassign
    // it to smuggle the unguarded constructor back onto instances.
    await expect(
      runScript(`
Date.prototype.constructor = function () { return { now: () => 1 } }
return 'reassigned'`),
    ).rejects.toThrow(/read.?only|Cannot assign/i);
  });

  it('does not let parallel() swallow the agent-call cap', async () => {
    await expect(
      runScript(
        `
return await parallel([1, 2, 3, 4, 5].map((n) => () => agent('call-' + n)))`,
        { maxAgentCalls: 3 },
      ),
    ).rejects.toThrow(/agent-call cap/);
  });

  it('lets parallel() surface script bugs to the editable-file retry path', async () => {
    await expect(
      runScript(`
return await parallel([
  () => agent('ok'),
  () => { throw new Error('script bug here') },
])`),
    ).rejects.toThrow('script bug here');
  });

  it('aborts new agent calls after the wall-clock timeout', async () => {
    let calls = 0;
    let sawAbort = false;
    const runner = async (invocation: WorkflowAgentInvocation) => {
      calls += 1;
      invocation.signal.addEventListener('abort', () => {
        sawAbort = true;
      });
      // Wide margin over timeoutMs: the timeout timer must fire before this
      // runner resolves even under heavy CI scheduler pressure, or the
      // orphaned continuation could reach agent('two') before the abort.
      await delay(150);
      return invocation.prompt;
    };
    await expect(
      runScript(
        `
await agent('one')
return await agent('two')`,
        { runAgent: runner, timeoutMs: 50 },
      ),
    ).rejects.toThrow(/timed out/);
    // Let the orphaned continuation reach its second agent() call.
    await delay(250);
    expect(calls).toBe(1);
    expect(sawAbort).toBe(true);
  });

  it('honors meta.timeoutMs when no run option is given', async () => {
    await expect(
      runWorkflowScript({
        script: `export const meta = {
  name: 'engine-test',
  description: 'meta-declared wall clock',
  timeoutMs: 1000,
}
return await agent('one')`,
        runAgent: async () => {
          await delay(2_500);
          return 'late';
        },
      }),
    ).rejects.toThrow(/timed out/);
  });

  it('lets an explicit run option override meta.timeoutMs', async () => {
    const startedAt = Date.now();
    await expect(
      runWorkflowScript({
        script: `export const meta = {
  name: 'engine-test',
  description: 'run option beats meta',
  timeoutMs: 3600000,
}
return await agent('one')`,
        runAgent: async () => {
          await delay(300);
          return 'late';
        },
        timeoutMs: 40,
      }),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it.each([
    { reachedVia: 'an agent await', body: `await agent('one')` },
    {
      reachedVia: 'the guest microtask queue',
      body: `await Promise.resolve()`,
    },
  ])('preempts a CPU loop reached through $reachedVia', async ({ body }) => {
    const startedAt = Date.now();
    await expect(
      runScript(
        `
${body}
while (true) {}`,
        { timeoutMs: 40 },
      ),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('ignores a host promise that settles after its runtime is disposed', async () => {
    let resolveHost!: (payload: string) => void;
    const hostResult = new Promise<string>((resolve) => {
      resolveHost = resolve;
    });
    const onTimeout = vi.fn();

    await expect(
      runScriptInSandbox(
        `await agent('slow'); return 'unreachable'`,
        sandboxBridge({ asyncFns: { agent: () => hostResult } }),
        {
          filename: 'late-host-promise.workflow.js',
          timeoutMs: 30,
          onTimeout,
        },
      ),
    ).rejects.toThrow(/timed out/);

    resolveHost('"late"');
    await delay(0);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    const nextRun = await runScript(`return 7`);
    expect(nextRun.result).toBe(7);
  });

  it('surfaces malformed host result JSON instead of substituting a value', async () => {
    await expect(
      runScriptInSandbox(
        `return await agent('malformed')`,
        sandboxBridge({ asyncFns: { agent: async () => '{' } }),
        { filename: 'malformed-host-result.workflow.js', timeoutMs: 1_000 },
      ),
    ).rejects.toThrow(/expecting property name|JSON|unexpected end/i);
  });

  it('rejects non-serializable agent results instead of journaling null', async () => {
    const events: WorkflowScriptEvent[] = [];
    await expect(
      runWorkflowScript({
        script: `${META}return await agent('function-result')`,
        runAgent: async (invocation) => {
          invocation.report?.({ model: 'serialization-model' });
          return () => undefined;
        },
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow(/agent\(\) result must be JSON-serializable/i);
    expect(events).toEqual([
      {
        type: 'agent:start',
        progressId: 'call-0',
        index: 0,
        label: 'function-result',
        phase: undefined,
      },
      {
        type: 'agent:end',
        progressId: 'call-0',
        index: 0,
        label: 'function-result',
        phase: undefined,
        outcome: 'failed',
        error: expect.stringMatching(/must be JSON-serializable/i),
        model: 'serialization-model',
        durationMs: expect.any(Number),
      },
    ]);
  });

  it('rejects explicitly supplied non-serializable workflow args', async () => {
    await expect(
      runScript(`return args`, { args: Symbol('not-json') }),
    ).rejects.toThrow(/Workflow args must be JSON-serializable/i);
  });

  it('rejects malformed args JSON while installing the bridge', async () => {
    await expect(
      runScriptInSandbox(`return args`, sandboxBridge({ argsJson: '{' }), {
        filename: 'malformed-args.workflow.js',
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/expecting property name|JSON|unexpected end/i);
  });

  it('aborts parallel siblings when one continuation runs forever', async () => {
    let sawAbort = false;
    const runner = (invocation: WorkflowAgentInvocation) =>
      new Promise<string>((resolve) => {
        invocation.signal.addEventListener('abort', () => {
          sawAbort = true;
          resolve('aborted');
        });
      });

    await expect(
      runScript(
        `
return await parallel([
  () => agent('waiting-sibling'),
  async () => { await Promise.resolve(); while (true) {} },
])`,
        { runAgent: runner, timeoutMs: 40 },
      ),
    ).rejects.toThrow(/timed out/);
    expect(sawAbort).toBe(true);
  });

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
  it('contains guest memory exhaustion inside the QuickJS runtime', async () => {
    await expect(
      runScript(
        `
const values = []
while (true) values.push(new Uint8Array(1024 * 1024))`,
        { timeoutMs: 2_000 },
      ),
    ).rejects.toThrow(/memory/i);
  }, 150_000);

  it('aborts in-flight agents when the call cap trips', async () => {
    let sawAbort = false;
    const runner = async (invocation: WorkflowAgentInvocation) => {
      invocation.signal.addEventListener('abort', () => {
        sawAbort = true;
      });
      await delay(30);
      return invocation.prompt;
    };
    await expect(
      runScript(
        `
return await parallel([1, 2, 3, 4, 5].map((n) => () => agent('call-' + n)))`,
        { runAgent: runner, maxAgentCalls: 3 },
      ),
    ).rejects.toThrow(/agent-call cap/);
    expect(sawAbort).toBe(true);
  });

  it('blocks caller-chain escapes from sloppy-mode thunks (strict scripts)', async () => {
    // Thunks run realm-side and sandbox bodies are forced into strict mode,
    // so arguments.callee.caller is unavailable even without this guard —
    // this covers non-strict callables a script might still construct.
    const run = await runScript(`
return await parallel([function () {
  try {
    return arguments.callee.caller.constructor('return typeof process')()
  } catch {
    return 'blocked'
  }
}])`);
    expect(run.result).toEqual(['blocked']);
  });

  it('drains agent() calls the script abandoned without awaiting', async () => {
    let settled = 0;
    let sawAbort = false;
    const runner = async (invocation: WorkflowAgentInvocation) => {
      invocation.signal.addEventListener('abort', () => {
        sawAbort = true;
      });
      await delay(40);
      settled += 1;
      return invocation.prompt;
    };
    const run = await runScript(
      `
const abandoned = agent('slow')
return 'done'`,
      { runAgent: runner },
    );
    expect(run.result).toBe('done');
    // The run waited for the straggler to settle (journal is final)...
    expect(settled).toBe(1);
    expect(run.journal).toHaveLength(1);
    // ...and told it to stop consuming quota.
    expect(sawAbort).toBe(true);
  });

  it('stops the workflow when a runner surfaces the run abort', async () => {
    const events: WorkflowScriptEvent[] = [];
    const runner = (invocation: WorkflowAgentInvocation) => {
      invocation.report?.({ model: 'abort-model' });
      const abortError = new Error('runner observed abort');
      abortError.name = 'WorkflowRunAbortError';
      return Promise.reject(abortError);
    };
    await expect(
      runScript(
        `
return await parallel([() => agent('x')])`,
        { runAgent: runner, onEvent: (event) => events.push(event) },
      ),
    ).rejects.toThrow(/runner observed abort/);
    expect(events).toContainEqual({
      type: 'agent:end',
      progressId: 'call-0',
      index: 0,
      label: 'x',
      phase: undefined,
      outcome: 'failed',
      error: 'runner observed abort',
      model: 'abort-model',
      durationMs: expect.any(Number),
    });
    expect(events.filter((event) => event.type === 'agent:end')).toHaveLength(
      1,
    );
  });

  it('does not let script code suppress a fatal runner abort', async () => {
    const runner = () => {
      const abortError = new Error('durable manifest unavailable');
      abortError.name = 'WorkflowRunAbortError';
      return Promise.reject(abortError);
    };

    await expect(
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
  });

  it('gives the script a name-only copy of a host-minted abort reason', async () => {
    // An abort reason crosses the sandbox boundary as name and message only,
    // so its host-side `kind` never reaches the script and script-side code
    // can only ever be classified structurally, by name.
    const logs: string[] = [];
    const run = runScript(
      `
try {
  await agent('over-cap')
} catch (error) {
  log(JSON.stringify({
    name: error.name,
    message: error.message,
    kind: error.kind ?? null,
    realmLocal: error instanceof Error,
  }))
}
return 'suppressed'`,
      {
        maxAgentCalls: 0,
        onEvent: (event) => {
          if (event.type === 'log') logs.push(event.message);
        },
      },
    );
    const fault = await run.catch((error: unknown) => error);

    expect(fault).toBeInstanceOf(WorkflowRunAbortError);
    expect(fault).toMatchObject({ kind: 'cap' });
    expect(JSON.parse(logs[0] ?? 'null')).toEqual({
      name: 'WorkflowRunAbortError',
      message: expect.stringContaining('agent-call cap'),
      kind: null,
      realmLocal: true,
    });
  });

  it('promotes an abort surfaced by name to a typed run fault', async () => {
    // Runner-minted aborts and realm copies are not instances, so the name is
    // what classifies them; the run then reports its own typed reason.
    const surfaced = new Error('durable manifest unavailable');
    surfaced.name = 'WorkflowRunAbortError';
    expect(surfaced).not.toBeInstanceOf(WorkflowRunAbortError);

    const fault = await runScript(`return await agent('x')`, {
      runAgent: () => Promise.reject(surfaced),
    }).catch((error: unknown) => error);

    expect(fault).toBeInstanceOf(WorkflowRunAbortError);
    expect(fault).toMatchObject({
      kind: 'runner',
      message: 'durable manifest unavailable',
      cause: surfaced,
    });
  });

  it('cancels calls the script abandoned with a settlement-cleanup reason', async () => {
    let cancelReason: unknown;
    const run = await runScript(
      `
agent('abandoned')
return 'done'`,
      {
        runAgent: (invocation: WorkflowAgentInvocation) =>
          new Promise<string>((resolve) => {
            invocation.signal.addEventListener(
              'abort',
              () => {
                cancelReason = invocation.signal.reason;
                resolve('cancelled');
              },
              { once: true },
            );
          }),
      },
    );

    // The cleanup cancellation is not a fault: the script outcome stands.
    expect(run.result).toBe('done');
    expect(cancelReason).toBeInstanceOf(WorkflowRunAbortError);
    expect(cancelReason).toMatchObject({ kind: 'settlement-cleanup' });
  });

  it('reports the timeout, not the queued call the timeout cancelled', async () => {
    const events: WorkflowScriptEvent[] = [];
    await expect(
      runScript(
        `
return await parallel([() => agent('running'), () => agent('queued')])`,
        {
          concurrency: 1,
          timeoutMs: 40,
          runAgent: async (invocation: WorkflowAgentInvocation) => {
            await delay(200);
            return invocation.prompt;
          },
          onEvent: (event) => events.push(event),
        },
      ),
    ).rejects.toThrow(/timed out/);
    // The call that reached its queue slot after the timeout fails with the
    // reason that stopped the run, and that reason does not outrank the
    // sandbox's timeout error.
    expect(
      events.filter(
        (event) => event.type === 'agent:end' && event.outcome === 'failed',
      ),
    ).toContainEqual(
      expect.objectContaining({
        label: 'queued',
        error: expect.stringContaining('wall clock'),
      }),
    );
  });

  it('aborts guest execution and the active child from a parent signal', async () => {
    const controller = new AbortController();
    let childSignal: AbortSignal | undefined;
    const run = runWorkflowScript({
      script: `${META}return await agent('wait')`,
      signal: controller.signal,
      runAgent: (invocation) => {
        childSignal = invocation.signal;
        return new Promise((_resolve, reject) => {
          invocation.signal.addEventListener(
            'abort',
            () => reject(invocation.signal.reason),
            { once: true },
          );
        });
      },
    });
    await vi.waitFor(() => expect(childSignal).toBeDefined());

    controller.abort(new DOMException('parent stopped', 'AbortError'));

    await expect(run).rejects.toMatchObject({
      name: 'AbortError',
      message: 'parent stopped',
    });
    expect(childSignal?.aborted).toBe(true);
  });

  it('skip(childExecutionId) skips only that call: SKIPPED result, no journal, siblings finish', async () => {
    const started = new Set<number>();
    const release = new Map<number, () => void>();
    const events: WorkflowScriptEvent[] = [];
    let control!: WorkflowScriptControl;
    const runner = (invocation: WorkflowAgentInvocation) =>
      new Promise<string>((resolve, reject) => {
        started.add(invocation.index);
        invocation.report?.({
          model: 'skip-model',
          childExecutionId: childExecutionIdFor(invocation.index),
        });
        release.set(invocation.index, () =>
          resolve(`done:${invocation.index}`),
        );
        rejectOnAbort(invocation, reject);
      });

    const runPromise = runWorkflowScript({
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
      onEvent: (event) => events.push(event),
    });

    await vi.waitFor(() => expect(started.size).toBe(3));
    control(childExecutionIdFor(1), 'skip');
    // Siblings settle normally; only index 1 is cancelled.
    release.get(0)?.();
    release.get(2)?.();

    const run = await runPromise;
    const result = run.result as string[];
    expect(result[0]).toBe('done:0');
    expect(result[1]).toBe(WORKFLOW_SKIPPED_RESULT);
    expect(result[2]).toBe('done:2');
    // Skipped call is NOT journaled (resume re-runs it); siblings are.
    expect(run.journal.map((entry) => entry.index).toSorted()).toEqual([0, 2]);
    expect(events).toContainEqual({
      type: 'agent:end',
      progressId: 'b',
      index: 1,
      label: 'b',
      phase: undefined,
      outcome: 'skipped',
      reason: 'user',
      model: 'skip-model',
      durationMs: expect.any(Number),
    });
  });

  it('makes a call controllable the moment its child id is reported', async () => {
    // Control is keyed by the child id the runner reports, so the earliest a
    // host can target an attempt is the instant that id exists — which is
    // still early enough to cancel the attempt before it produces a result.
    let control!: WorkflowScriptControl;
    const runner = vi.fn(
      (invocation: WorkflowAgentInvocation) =>
        new Promise<string>((_resolve, reject) => {
          rejectOnAbort(invocation, reject);
          invocation.report?.({
            childExecutionId: childExecutionIdFor(invocation.index),
          });
          control(childExecutionIdFor(invocation.index), 'skip');
        }),
    );
    const run = await runWorkflowScript({
      script: `${META}return await agent('skip immediately')`,
      runAgent: runner,
      onControl: (handle) => {
        control = handle;
      },
    });

    expect(run.result).toBe(WORKFLOW_SKIPPED_RESULT);
    expect(run.journal).toEqual([]);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('retry(childExecutionId) re-runs a single in-flight call and yields the new result', async () => {
    const attemptByIndex = new Map<number, number>();
    const releases: Array<() => void> = [];
    let control!: WorkflowScriptControl;
    const runner = (invocation: WorkflowAgentInvocation) =>
      new Promise<string>((resolve, reject) => {
        const attempt = (attemptByIndex.get(invocation.index) ?? 0) + 1;
        attemptByIndex.set(invocation.index, attempt);
        invocation.report?.({
          childExecutionId: childExecutionIdFor(invocation.index, attempt),
        });
        releases.push(() => resolve(`attempt-${attempt}`));
        rejectOnAbort(invocation, reject);
      });

    const runPromise = runWorkflowScript({
      script: `${META}return await agent('go')`,
      runAgent: runner,
      onControl: (handle) => {
        control = handle;
      },
    });

    await vi.waitFor(() => expect(attemptByIndex.get(0)).toBe(1));
    control(childExecutionIdFor(0, 1), 'retry');
    // The aborted first attempt is discarded; a fresh attempt starts.
    await vi.waitFor(() => expect(attemptByIndex.get(0)).toBe(2));
    releases.at(-1)?.();

    const run = await runPromise;
    expect(run.result).toBe('attempt-2');
    // Journaled exactly once, with the new attempt's result (no double-journal).
    expect(run.journal).toEqual([
      {
        index: 0,
        key: expect.any(String),
        result: 'attempt-2',
      },
    ]);
  });

  it('forgets an abandoned attempt id so a stale request cannot skip its successor', async () => {
    const attemptByIndex = new Map<number, number>();
    const releases: Array<() => void> = [];
    let control!: WorkflowScriptControl;
    const runner = (invocation: WorkflowAgentInvocation) =>
      new Promise<string>((resolve, reject) => {
        rejectOnAbort(invocation, reject);
        const attempt = (attemptByIndex.get(invocation.index) ?? 0) + 1;
        attemptByIndex.set(invocation.index, attempt);
        invocation.report?.({
          childExecutionId: childExecutionIdFor(invocation.index, attempt),
        });
        releases.push(() => resolve(`attempt-${attempt}`));
      });

    const runPromise = runWorkflowScript({
      script: `${META}return await agent('go')`,
      runAgent: runner,
      onControl: (handle) => {
        control = handle;
      },
    });

    await vi.waitFor(() => expect(attemptByIndex.get(0)).toBe(1));
    control(childExecutionIdFor(0, 1), 'retry');
    await vi.waitFor(() => expect(attemptByIndex.get(0)).toBe(2));
    // The retried attempt runs under a new id; the abandoned one is dead and
    // must not reach the fresh attempt that now owns the call.
    control(childExecutionIdFor(0, 1), 'skip');
    releases.at(-1)?.();

    const run = await runPromise;
    expect(run.result).toBe('attempt-2');
  });

  it('never registers a recovered child id as a skip/retry target', async () => {
    let control!: WorkflowScriptControl;
    let releaseCall!: () => void;
    const recoveredId = childExecutionIdFor(0, 1);
    const runner = (invocation: WorkflowAgentInvocation) =>
      new Promise<string>((resolve, reject) => {
        rejectOnAbort(invocation, reject);
        // A durable-recovery runner re-attaches the known child id for
        // navigation, then keeps resolving asynchronously (readMeta gap).
        invocation.report?.({
          childExecutionId: recoveredId,
          recovered: true,
        });
        releaseCall = () => resolve('recovered-result');
      });

    const runPromise = runWorkflowScript({
      script: `${META}return await agent('go')`,
      runAgent: runner,
      onControl: (handle) => {
        control = handle;
      },
    });

    await vi.waitFor(() => expect(releaseCall).toBeDefined());
    // The skip lands inside the recovery window; a recovered result is
    // authoritative, so the request must no-op instead of discarding it.
    control(recoveredId, 'skip');
    releaseCall();

    const run = await runPromise;
    expect(run.result).toBe('recovered-result');
  });

  it('keeps a journaled completed call completed when the completed emit throws', async () => {
    const snapshots: WorkflowScriptRunResult['snapshot'][] = [];
    const runPromise = runWorkflowScript({
      script: `${META}return await agent('go')`,
      runAgent: async () => 'done',
      onSnapshot: (snapshot) => {
        snapshots.push(snapshot);
      },
      onEvent: (event) => {
        // The call is already journaled and settled COMPLETED when this
        // event fires; a throwing host handler must not rewrite it.
        if (event.type === 'agent:end' && event.outcome === 'completed') {
          throw new Error('host event handler exploded');
        }
      },
    });

    await expect(runPromise).rejects.toThrow('host event handler exploded');
    const terminal = snapshots.at(-1);
    expect(terminal?.calls[0]).toMatchObject({ status: 'completed' });
  });

  it('charges every retry attempt against the live-call cap', async () => {
    let control!: WorkflowScriptControl;
    const events: WorkflowScriptEvent[] = [];
    let attempts = 0;
    const runner = vi.fn((invocation: WorkflowAgentInvocation) => {
      attempts += 1;
      invocation.report?.({
        model: 'retry-model',
        childExecutionId: childExecutionIdFor(invocation.index, attempts),
      });
      return new Promise<never>((_resolve, reject) => {
        rejectOnAbort(invocation, reject);
      });
    });
    const run = runWorkflowScript({
      script: `${META}return await agent('retry until refused')`,
      runAgent: runner,
      maxAgentCalls: 2,
      onControl: (handle) => {
        control = handle;
      },
      onEvent: (event) => events.push(event),
    });

    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    control(childExecutionIdFor(0, 1), 'retry');
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2));
    control(childExecutionIdFor(0, 2), 'retry');

    await expect(run).rejects.toThrow(/agent-call cap/);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent:end',
        progressId: 'call-0',
        index: 0,
        outcome: 'failed',
        error: expect.stringContaining('agent-call cap'),
        model: 'retry-model',
        durationMs: expect.any(Number),
      }),
    );
    expect(events.filter((event) => event.type === 'agent:end')).toHaveLength(
      1,
    );
  });

  it('a whole-run abort cascades to every in-flight per-call controller', async () => {
    const started = new Set<number>();
    const aborted = new Set<number>();
    const parent = new AbortController();
    const runner = (invocation: WorkflowAgentInvocation) =>
      new Promise<string>((_resolve, reject) => {
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

    const runPromise = runScript(
      `return await parallel([
  () => agent('a', { id: 'a' }),
  () => agent('b', { id: 'b' }),
])`,
      { runAgent: runner, concurrency: 2, signal: parent.signal },
    );

    await vi.waitFor(() => expect(started.size).toBe(2));
    parent.abort(new DOMException('parent stopped', 'AbortError'));

    await expect(runPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted).toEqual(new Set([0, 1]));
  });

  it('owns a terminal canonical snapshot with direct-call counts', async () => {
    const snapshots: WorkflowScriptRunResult['snapshot'][] = [];
    const result = await runWorkflowScript({
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
      runAgent: async (invocation) => {
        // One report carrying every fact the host resolved must land them all.
        invocation.report?.({
          agent: 'writer',
          model: 'model-a',
          childExecutionId: 'abcdef123456',
          childStreamId: 'writer#abcdef123456',
        });
        return 'drafted';
      },
      onSnapshot: (snapshot) => {
        snapshots.push(snapshot);
      },
    });

    expect(snapshots.length).toBeGreaterThan(0);
    expect(result.snapshot).toMatchObject({
      lifecycle: 'completed',
      currentStageId: undefined,
      calls: [
        {
          id: 'draft',
          status: 'completed',
          agent: 'writer',
          model: 'model-a',
          childExecutionId: 'abcdef123456',
          childStreamId: 'writer#abcdef123456',
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
  });

  it('uses safe canonical labels for dynamic calls', async () => {
    const result = await runWorkflowScript({
      script: `export const meta = {
  name: 'labels',
  description: 'label workflow',
}
return await agent('secret full instruction', {
  inputFiles: ['/private/host/path/paper.tex'],
  agentName: 'proofreader',
})`,
      fingerprintAgentDependencies: async () => 'fingerprint',
      runAgent: async () => 'done',
    });

    expect(result.snapshot.calls[0]).toMatchObject({
      label: 'paper.tex: proofreader',
      files: { input: ['paper.tex'], context: [], media: [] },
    });
    expect(JSON.stringify(result.snapshot)).not.toContain('/private/host/path');
    expect(JSON.stringify(result.snapshot)).not.toContain(
      'secret full instruction',
    );
  });

  it('removes Intl so scripts cannot read the wall clock implicitly', async () => {
    await expect(
      runScript(`return new Intl.DateTimeFormat().format()`),
    ).rejects.toThrow();
  });
});
