import { describe, expect, it, vi } from 'vitest';

import {
  parseWorkflowScript,
  runWorkflowScript,
  WorkflowScriptParseError,
  type WorkflowAgentInvocation,
  type WorkflowScriptEvent,
} from '@agent/workflowScript';

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
        await new Promise((resolve) => setTimeout(resolve, 40));
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
      await new Promise((resolve) => setTimeout(resolve, 10));
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

  it('concat() joins parts and drops nulls', async () => {
    const run = await runWorkflowScript({
      script: `${META}return concat(['a', null, 'b', '', 'c'], { separator: ' | ' })`,
      runAgent: echoRunner,
    });
    expect(run.result).toBe('a | b | c');
  });

  it('blocks Date.now() and Math.random() inside scripts', async () => {
    await expect(
      runWorkflowScript({ script: `${META}return Date.now()`, runAgent: echoRunner }),
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
      runWorkflowScript({ script: `${META}return await agent('')`, runAgent: echoRunner }),
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
  });
});
