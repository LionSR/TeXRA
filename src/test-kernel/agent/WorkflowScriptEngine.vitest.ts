import { describe, expect, it, vi } from 'vitest';

import {
  parseWorkflowScript,
  runWorkflowScript,
  WorkflowScriptParseError,
  type WorkflowAgentInvocation,
  type WorkflowScriptEvent,
} from '@agent/workflowScript';
import { runScriptInSandbox } from '@agent/workflowScript/sandbox';
import { delay } from '@utils/core';

const META = `export const meta = {
  name: 'test-flow',
  description: 'engine test flow',
  phases: [{ title: 'Work' }],
}\n`;

function echoRunner(invocation: WorkflowAgentInvocation): Promise<string> {
  return Promise.resolve(`result:${invocation.prompt}`);
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

  it('rejects non-literal meta referencing script identifiers', () => {
    expect(() =>
      parseWorkflowScript(
        `export const meta = { name: buildName(), description: 'd' }\nreturn 1`,
      ),
    ).toThrow(/pure object literal/);
  });

  it('rejects module imports and require', () => {
    expect(() =>
      parseWorkflowScript(`${META}const fs = require('node:fs')`),
    ).toThrow(/cannot import/);
    expect(() =>
      parseWorkflowScript(`import fs from 'node:fs'\n${META}`),
    ).toThrow(/cannot import/);
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
  it('runs a script end-to-end with agent calls and args', async () => {
    const run = await runWorkflowScript({
      script: `${META}
const a = await agent('alpha')
const b = await agent('beta:' + args.suffix)
return [a, b]`,
      args: { suffix: 'S' },
      runAgent: echoRunner,
    });
    expect(run.result).toEqual(['result:alpha', 'result:beta:S']);
    expect(run.agentCalls).toBe(2);
    expect(run.journal).toHaveLength(2);
    expect(run.meta.name).toBe('test-flow');
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
    });

    expect(invocations[1]?.options.inputFiles).toEqual([outputPath]);
    expect(run.result).toMatchObject({
      category: 'workflow',
      outcome: 'completed',
    });
  });

  it('parallel(): failed thunks resolve to null without aborting siblings', async () => {
    const run = await runWorkflowScript({
      script: `${META}
return await parallel([
  () => agent('ok-1'),
  () => { throw new Error('thunk boom') },
  () => agent('ok-2'),
])`,
      runAgent: echoRunner,
    });
    expect(run.result).toEqual(['result:ok-1', null, 'result:ok-2']);
  });

  it('agent() resolves to null on runner failure and is not journaled', async () => {
    const runner = vi.fn((invocation: WorkflowAgentInvocation) =>
      invocation.prompt === 'boom'
        ? Promise.reject(new Error('runner failed'))
        : echoRunner(invocation),
    );
    const run = await runWorkflowScript({
      script: `${META}return [await agent('boom'), await agent('fine')]`,
      runAgent: runner,
    });
    expect(run.result).toEqual([null, 'result:fine']);
    // Only the successful call is journaled, so a resume retries the failure.
    expect(run.journal.map((entry) => entry.index)).toEqual([1]);
  });

  it('pipeline(): no barrier between stages', async () => {
    const stage2Order: string[] = [];
    const events: WorkflowScriptEvent[] = [];
    const runner = async (invocation: WorkflowAgentInvocation) => {
      if (invocation.prompt === 'slow') {
        await delay(40);
      }
      return invocation.prompt;
    };
    const run = await runWorkflowScript({
      script: `${META}
return await pipeline(
  ['fast', 'slow'],
  (item) => agent(item),
  async (prev, item) => { log('stage2:' + item); return prev + '!' },
)`,
      runAgent: runner,
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'log') stage2Order.push(event.message);
      },
    });
    expect(run.result).toEqual(['fast!', 'slow!']);
    // The fast item reached stage 2 while the slow item was still in stage 1.
    expect(stage2Order).toEqual(['stage2:fast', 'stage2:slow']);
  });

  it('pipeline(): a throwing stage drops only that item to null', async () => {
    const run = await runWorkflowScript({
      script: `${META}
return await pipeline(
  [1, 2, 3],
  (item) => { if (item === 2) throw new Error('drop'); return item * 10 },
  (prev) => prev + 1,
)`,
      runAgent: echoRunner,
    });
    expect(run.result).toEqual([11, null, 31]);
  });

  it('bounds concurrent agent() calls with the semaphore', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const runner = async (invocation: WorkflowAgentInvocation) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(10);
      inFlight -= 1;
      return invocation.prompt;
    };
    await runWorkflowScript({
      script: `${META}
return await parallel([1, 2, 3, 4, 5, 6].map((n) => () => agent('call-' + n)))`,
      runAgent: runner,
      concurrency: 2,
    });
    expect(maxInFlight).toBe(2);
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
    const edited = await runWorkflowScript({
      script: `${META}
const a = await agent('stage-a')
const b = await agent('stage-b-EDITED:' + a)
return b`,
      runAgent: editedRunner,
      journal: first.journal,
    });
    expect(edited.result).toBe('result:stage-b-EDITED:result:stage-a');
    expect(editedRunner).toHaveBeenCalledTimes(1);
    expect(editedRunner.mock.calls[0][0].prompt).toBe(
      'stage-b-EDITED:result:stage-a',
    );
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
        index: 0,
        label: 'cached',
        cached: true,
        error: expect.stringMatching(/must be JSON-serializable/i),
      },
    ]);
  });

  it('concat() joins parts and drops nulls', async () => {
    const run = await runWorkflowScript({
      script: `${META}return concat(['a', null, 'b', '', 'c'], { separator: ' | ' })`,
      runAgent: echoRunner,
    });
    expect(run.result).toBe('a | b | c');
  });

  it('blocks Date.now() and Math.random() inside scripts', async () => {
    await expect(
      runWorkflowScript({
        script: `${META}return Date.now()`,
        runAgent: echoRunner,
      }),
    ).rejects.toThrow(/Date\.now\(\) is unavailable/);
    await expect(
      runWorkflowScript({
        script: `${META}return Math.random()`,
        runAgent: echoRunner,
      }),
    ).rejects.toThrow(/Math\.random\(\) is unavailable/);
  });

  it('enforces the lifetime agent-call cap', async () => {
    await expect(
      runWorkflowScript({
        script: `${META}
for (let i = 0; i < 10; i++) await agent('call-' + i)
return 'done'`,
        runAgent: echoRunner,
        maxAgentCalls: 3,
      }),
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
      runAgent: (invocation) => {
        invocations.push(invocation);
        return echoRunner(invocation);
      },
      onEvent: (event) => events.push(event),
    });
    expect(invocations[0].options.phase).toBe('Work');
    expect(events).toContainEqual({ type: 'phase', title: 'Work' });
    expect(events).toContainEqual({
      type: 'agent:start',
      index: 0,
      label: 'labelled',
      phase: 'Work',
    });
  });

  it('rejects invalid primitive usage with clear errors', async () => {
    await expect(
      runWorkflowScript({
        script: `${META}return await agent('')`,
        runAgent: echoRunner,
      }),
    ).rejects.toThrow(/non-empty string prompt/);
    await expect(
      runWorkflowScript({
        script: `${META}return await parallel('nope')`,
        runAgent: echoRunner,
      }),
    ).rejects.toThrow(/array of zero-arg functions/);
    await expect(
      runWorkflowScript({
        script: `${META}return await pipeline([1])`,
        runAgent: echoRunner,
      }),
    ).rejects.toThrow(/at least one stage/);
    await expect(
      runWorkflowScript({
        script: `${META}return await agent('x', [])`,
        runAgent: echoRunner,
      }),
    ).rejects.toThrow(/must be a plain object/);
    await expect(
      runWorkflowScript({
        script: `${META}return await agent('x', { inputFiles: [''] })`,
        runAgent: echoRunner,
      }),
    ).rejects.toThrow(/inputFiles.*array of non-empty strings/);
  });

  it.each(['schema', 'outputSchema'] as const)(
    'rejects the obsolete %s option instead of silently ignoring it',
    async (field) => {
      const runner = vi.fn(echoRunner);
      await expect(
        runWorkflowScript({
          script: `${META}return await agent('x', { ${field}: { type: 'object' } })`,
          runAgent: runner,
        }),
      ).rejects.toThrow(/structured data.*JSON output file/);
      expect(runner).not.toHaveBeenCalled();
    },
  );

  it('blocks Function-constructor escapes through injected primitives', async () => {
    // agent is a realm-local wrapper, so its .constructor is the sandbox's
    // codeGeneration-gated (Async)Function — compiling from strings throws.
    await expect(
      runWorkflowScript({
        script: `${META}return agent.constructor('return process')()`,
        runAgent: echoRunner,
      }),
    ).rejects.toThrow(/disallowed/i);
  });

  it('does not leak a host Function via a callback passed to parallel()', async () => {
    // parallel/pipeline/concat run realm-side, so the thunk a script hands
    // them is only ever invoked by sandbox code: its `this`/args and any
    // .constructor it can reach are realm-local and codegen-gated. A host
    // callback would carry the ungated host Function constructor.
    const run = await runWorkflowScript({
      script: `${META}
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
return results[0]`,
      runAgent: echoRunner,
    });
    expect(typeof run.result).toBe('string');
    expect(run.result).toMatch(/^blocked:/);
  });

  it('does not leak a host Function through an overridden array method', async () => {
    // The classic escape: override the array's own filter/map so the
    // dispatcher passes a host callback into it. concat() runs realm-side,
    // so the override only ever receives realm-local callables.
    const run = await runWorkflowScript({
      script: `${META}
let captured = null
const parts = ['a', 'b']
parts.filter = function (cb) {
  captured = cb
  return this
}
concat(parts)
try {
  const escaped = captured.constructor('return typeof process')()
  return 'leaked:' + escaped
} catch (error) {
  return 'blocked:' + (error && error.name)
}`,
      runAgent: echoRunner,
    });
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
    const run = await runWorkflowScript({
      script: `${META}
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
return results[0]`,
      runAgent: echoRunner,
    });
    expect(run.result).toMatch(/^blocked:/);
  });

  it('reports an unserializable return value as an error, not a timeout', async () => {
    // A BigInt (or circular object) cannot be JSON-encoded; the realm-side
    // deliver must route that through the error path immediately instead of
    // throwing and leaving the host promise to hang until the wall clock.
    await expect(
      runWorkflowScript({
        script: `${META}return 1n`,
        runAgent: echoRunner,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/not JSON-serializable/i);
  });

  it('cannot forge a result by overriding Promise.prototype.then', async () => {
    // then/catch/finally are locked non-writable before the body runs, so a
    // script that tries to reassign then (to invoke the kickoff's delivery
    // callback with a forged value) gets a real result — the reassignment
    // throws under strict mode, or is simply ignored — not a forged success.
    const run = await runWorkflowScript({
      script: `${META}
try {
  Promise.prototype.then = function () { return this }
} catch (error) {
  // strict-mode assignment to a non-writable property throws; swallow it
}
return 'real-result'`,
      runAgent: echoRunner,
    });
    expect(run.result).toBe('real-result');
  });

  it('does not expose the result delivery channel to scripts', async () => {
    // The kickoff captures and deletes __wfDeliver/__wfBody before the body
    // runs, so a script cannot forge an early result through them.
    const run = await runWorkflowScript({
      script: `${META}
return [typeof globalThis.__wfDeliver, typeof globalThis.__wfBody]`,
      runAgent: echoRunner,
    });
    expect(run.result).toEqual(['undefined', 'undefined']);
  });

  it('keeps a delivered result when a later guest microtask throws', async () => {
    const run = await runWorkflowScript({
      script: `${META}
Promise.resolve().then(() => {
  Promise.resolve().then(() => { throw new Error('late rejection') })
})
return 'delivered'`,
      runAgent: echoRunner,
    });

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
      { asyncFns: {}, syncFns: {}, argsJson: undefined },
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
    const run = await runWorkflowScript({
      script: `${META}
agent('detached')
return 'done'`,
      runAgent: runner,
    });
    expect(run.result).toBe('done');
    expect(sawAbort).toBe(true);
  });

  it('gives scripts realm-local agent results, not host objects', async () => {
    const runner = () => Promise.resolve({ nested: { data: 42 } });
    const run = await runWorkflowScript({
      script: `${META}
const r = await agent('x')
try {
  return r.constructor.constructor('return typeof process')()
} catch {
  return 'blocked:' + r.nested.data
}`,
      runAgent: runner,
    });
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
      runWorkflowScript({
        script: `${META}
Math.random = () => 0.5
return Math.random()`,
        runAgent: echoRunner,
      }),
    ).rejects.toThrow(/read.?only|unavailable/i);
    await expect(
      runWorkflowScript({
        script: `${META}return new Date()`,
        runAgent: echoRunner,
      }),
    ).rejects.toThrow(/new Date\(\) without arguments/);
    const explicit = await runWorkflowScript({
      script: `${META}return new Date(0).getTime()`,
      runAgent: echoRunner,
    });
    expect(explicit.result).toBe(0);
    // Date.prototype.constructor is locked too, so a script cannot reassign
    // it to smuggle the unguarded constructor back onto instances.
    await expect(
      runWorkflowScript({
        script: `${META}
Date.prototype.constructor = function () { return { now: () => 1 } }
return 'reassigned'`,
        runAgent: echoRunner,
      }),
    ).rejects.toThrow(/read.?only|Cannot assign/i);
  });

  it('does not let parallel() swallow the agent-call cap', async () => {
    await expect(
      runWorkflowScript({
        script: `${META}
return await parallel([1, 2, 3, 4, 5].map((n) => () => agent('call-' + n)))`,
        runAgent: echoRunner,
        maxAgentCalls: 3,
      }),
    ).rejects.toThrow(/agent-call cap/);
  });

  it('logs script bugs swallowed by parallel() so null slots are debuggable', async () => {
    const logs: string[] = [];
    const run = await runWorkflowScript({
      script: `${META}
return await parallel([
  () => agent('ok'),
  () => { throw new Error('script bug here') },
])`,
      runAgent: echoRunner,
      onEvent: (event) => {
        if (event.type === 'log') logs.push(event.message);
      },
    });
    expect(run.result).toEqual(['result:ok', null]);
    expect(logs.some((message) => message.includes('script bug here'))).toBe(
      true,
    );
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
      runWorkflowScript({
        script: `${META}
await agent('one')
return await agent('two')`,
        runAgent: runner,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out/);
    // Let the orphaned continuation reach its second agent() call.
    await delay(250);
    expect(calls).toBe(1);
    expect(sawAbort).toBe(true);
  });

  it('preempts a CPU loop reached after an agent await', async () => {
    const startedAt = Date.now();
    await expect(
      runWorkflowScript({
        script: `${META}
await agent('one')
while (true) {}`,
        runAgent: echoRunner,
        timeoutMs: 40,
      }),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('preempts a CPU loop reached through the guest microtask queue', async () => {
    const startedAt = Date.now();
    await expect(
      runWorkflowScript({
        script: `${META}
await Promise.resolve()
while (true) {}`,
        runAgent: echoRunner,
        timeoutMs: 40,
      }),
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
        {
          asyncFns: { agent: () => hostResult },
          syncFns: {},
          argsJson: undefined,
        },
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

    const nextRun = await runWorkflowScript({
      script: `${META}return 7`,
      runAgent: echoRunner,
    });
    expect(nextRun.result).toBe(7);
  });

  it('surfaces malformed host result JSON instead of substituting a value', async () => {
    await expect(
      runScriptInSandbox(
        `return await agent('malformed')`,
        {
          asyncFns: { agent: async () => '{' },
          syncFns: {},
          argsJson: undefined,
        },
        { filename: 'malformed-host-result.workflow.js', timeoutMs: 1_000 },
      ),
    ).rejects.toThrow(/expecting property name|JSON|unexpected end/i);
  });

  it('rejects non-serializable agent results instead of journaling null', async () => {
    const events: WorkflowScriptEvent[] = [];
    await expect(
      runWorkflowScript({
        script: `${META}return await agent('function-result')`,
        runAgent: async () => () => undefined,
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow(/agent\(\) result must be JSON-serializable/i);
    expect(events).toEqual([
      {
        type: 'agent:start',
        index: 0,
        label: 'function-result',
        phase: undefined,
      },
      {
        type: 'agent:end',
        index: 0,
        label: 'function-result',
        cached: false,
        error: expect.stringMatching(/must be JSON-serializable/i),
      },
    ]);
  });

  it('rejects explicitly supplied non-serializable workflow args', async () => {
    await expect(
      runWorkflowScript({
        script: `${META}return args`,
        args: Symbol('not-json'),
        runAgent: echoRunner,
      }),
    ).rejects.toThrow(/Workflow args must be JSON-serializable/i);
  });

  it('rejects malformed args JSON while installing the bridge', async () => {
    await expect(
      runScriptInSandbox(
        `return args`,
        { asyncFns: {}, syncFns: {}, argsJson: '{' },
        { filename: 'malformed-args.workflow.js', timeoutMs: 1_000 },
      ),
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
      runWorkflowScript({
        script: `${META}
return await parallel([
  () => agent('waiting-sibling'),
  async () => { await Promise.resolve(); while (true) {} },
])`,
        runAgent: runner,
        timeoutMs: 40,
      }),
    ).rejects.toThrow(/timed out/);
    expect(sawAbort).toBe(true);
  });

  it('contains guest memory exhaustion inside the QuickJS runtime', async () => {
    const startedAt = Date.now();
    await expect(
      runWorkflowScript({
        script: `${META}
const values = []
while (true) values.push(new Uint8Array(1024 * 1024))`,
        runAgent: echoRunner,
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow(/memory/i);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

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
      runWorkflowScript({
        script: `${META}
return await parallel([1, 2, 3, 4, 5].map((n) => () => agent('call-' + n)))`,
        runAgent: runner,
        maxAgentCalls: 3,
      }),
    ).rejects.toThrow(/agent-call cap/);
    expect(sawAbort).toBe(true);
  });

  it('blocks caller-chain escapes from sloppy-mode thunks (strict scripts)', async () => {
    // Thunks run realm-side and sandbox bodies are forced into strict mode,
    // so arguments.callee.caller is unavailable even without this guard —
    // this covers non-strict callables a script might still construct.
    const run = await runWorkflowScript({
      script: `${META}
return await parallel([function () {
  try {
    return arguments.callee.caller.constructor('return typeof process')()
  } catch {
    return 'blocked'
  }
}])`,
      runAgent: echoRunner,
    });
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
    const run = await runWorkflowScript({
      script: `${META}
const abandoned = agent('slow')
return 'done'`,
      runAgent: runner,
    });
    expect(run.result).toBe('done');
    // The run waited for the straggler to settle (journal is final)...
    expect(settled).toBe(1);
    expect(run.journal).toHaveLength(1);
    // ...and told it to stop consuming quota.
    expect(sawAbort).toBe(true);
  });

  it('stops the workflow when a runner surfaces the run abort', async () => {
    const runner = () => {
      const abortError = new Error('runner observed abort');
      abortError.name = 'WorkflowRunAbortError';
      return Promise.reject(abortError);
    };
    await expect(
      runWorkflowScript({
        script: `${META}
return await parallel([() => agent('x')])`,
        runAgent: runner,
      }),
    ).rejects.toThrow(/runner observed abort/);
  });

  it('removes Intl so scripts cannot read the wall clock implicitly', async () => {
    await expect(
      runWorkflowScript({
        script: `${META}return new Intl.DateTimeFormat().format()`,
        runAgent: echoRunner,
      }),
    ).rejects.toThrow();
  });
});
