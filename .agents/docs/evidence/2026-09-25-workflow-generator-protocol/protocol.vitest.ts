import { it } from '@effect/vitest';
import { Effect, Exit, Fiber, Deferred } from 'effect';
import { describe, expect } from 'vitest';

import { runWorkflow, type AgentCall, type WorkflowHost } from './interpreter';

/**
 * A fake agent runner. Options drive it: `delayMs` sleeps, `fail` fails,
 * `failTimes` fails that many attempts per prompt first. It records peak
 * concurrency, every call, and which calls were interrupted.
 */
function fakeHost(concurrency = 4) {
  let inFlight = 0;
  const stats = {
    peak: 0,
    calls: [] as string[],
    interrupted: [] as string[],
    attempts: new Map<string, number>(),
  };
  const runAgent = (call: AgentCall) =>
    Effect.gen(function* () {
      const n = (stats.attempts.get(call.prompt) ?? 0) + 1;
      stats.attempts.set(call.prompt, n);
      stats.calls.push(call.prompt);
      inFlight += 1;
      stats.peak = Math.max(stats.peak, inFlight);
      const delay = Number(call.options.delayMs ?? 0);
      if (delay > 0) yield* Effect.sleep(delay);
      if (
        call.options.fail === true ||
        n <= Number(call.options.failTimes ?? 0)
      ) {
        return yield* Effect.fail({ message: `agent failed: ${call.prompt}` });
      }
      return { response: `result:${call.prompt}` };
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => void stats.interrupted.push(call.prompt)),
      ),
      Effect.ensuring(Effect.sync(() => void (inFlight -= 1))),
    );
  const host: WorkflowHost<never> = { runAgent, concurrency };
  return { host, stats };
}

const run = (body: string, host: WorkflowHost<never>) =>
  runWorkflow(body, host);

describe('generator workflow protocol on an Effect interpreter', () => {
  it.effect('runs sequential agent() calls and returns plain data', () =>
    Effect.gen(function* () {
      const { host, stats } = fakeHost();
      const result = yield* run(
        `
const a = yield* agent('first')
const b = yield* agent('second: ' + a.response)
return [a.response, b.response]`,
        host,
      );
      expect(result).toEqual(['result:first', 'result:second: result:first']);
      expect(stats.calls).toEqual(['first', 'second: result:first']);
    }),
  );

  it.live(
    'all() fans out under the smaller of its own cap and the host budget',
    () =>
      Effect.gen(function* () {
        const { host, stats } = fakeHost(3);
        const result = yield* run(
          `
return yield* all(
  [1, 2, 3, 4, 5, 6, 7, 8].map((n) => agent('call-' + n, { delayMs: 20 })),
  { concurrency: 5 },
)`,
          host,
        );
        expect(result).toHaveLength(8);
        expect(stats.peak).toBe(3);
      }),
  );

  it.live(
    'nested fan-out stays under the host budget, and cannot deadlock it',
    () =>
      Effect.gen(function* () {
        const { host, stats } = fakeHost(3);
        // Two branches, each fanning out four calls: without one budget across
        // every branch this would run eight at once. Branches hold no permit
        // while they wait on children, so a budget of 1 still completes.
        const body = `
return yield* forEach(['a', 'b'], (group) => function* () {
  return yield* all([1, 2, 3, 4].map((n) => agent(group + n, { delayMs: 20 })))
})`;
        const result = yield* run(body, host);
        expect(result).toHaveLength(2);
        expect(stats.peak).toBe(3);
        const tight = fakeHost(1);
        yield* run(body, tight.host);
        expect(tight.stats.peak).toBe(1);
      }),
  );

  it.live('operations are lazy values: building them runs nothing', () =>
    Effect.gen(function* () {
      const { host, stats } = fakeHost();
      yield* run(
        `
const ops = ['a', 'b'].map((x) => agent(x))
if (ops.length !== 2) throw new Error('unexpected')
return 'built'`,
        host,
      );
      expect(stats.calls).toEqual([]);
    }),
  );

  it.live(
    'all() is fail-fast: the first failure interrupts running siblings',
    () =>
      Effect.gen(function* () {
        const { host, stats } = fakeHost();
        const exit = yield* Effect.exit(
          run(
            `
return yield* all([
  agent('slow', { delayMs: 500 }),
  agent('boom', { delayMs: 10, fail: true }),
])`,
            host,
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain('AgentFailed');
        expect(stats.interrupted).toContain('slow');
      }),
  );

  it.live(
    'attempt() turns failures into values, so partial fan-out survives',
    () =>
      Effect.gen(function* () {
        const { host } = fakeHost();
        const result = yield* run(
          `
const results = yield* all(['ok-1', 'bad', 'ok-2'].map((p) =>
  attempt(agent(p, { fail: p === 'bad' }))))
return results.map((r) => r._tag === 'Success' ? r.value.response : r.error.name)`,
          host,
        );
        expect(result).toEqual(['result:ok-1', 'AgentFailed', 'result:ok-2']);
      }),
  );

  it.effect(
    'a failed operation throws inside the script, with its tag as the name',
    () =>
      Effect.gen(function* () {
        const { host } = fakeHost();
        const result = yield* run(
          `
try {
  yield* agent('bad', { fail: true })
  return 'unreachable'
} catch (error) {
  return error.name + ': ' + error.message
}`,
          host,
        );
        expect(result).toBe('AgentFailed: agent failed: bad');
      }),
  );

  it.effect('retry() re-runs a failing call up to its limit', () =>
    Effect.gen(function* () {
      const { host, stats } = fakeHost();
      const result = yield* run(
        `return (yield* retry(agent('flaky', { failTimes: 2 }), { times: 2 })).response`,
        host,
      );
      expect(result).toBe('result:flaky');
      expect(stats.attempts.get('flaky')).toBe(3);
    }),
  );

  it.live(
    'retry() of a multi-step branch re-runs the whole branch from its start',
    () =>
      Effect.gen(function* () {
        const { host, stats } = fakeHost();
        const result = yield* run(
          `
return yield* retry(function* () {
  const draft = yield* agent('draft')
  const check = yield* agent('check', { failTimes: 1 })
  return draft.response + ' / ' + check.response
}, { times: 1 })`,
          host,
        );
        expect(result).toBe('result:draft / result:check');
        expect(stats.calls).toEqual(['draft', 'check', 'draft', 'check']);
      }),
  );

  it.live(
    'timeout() interrupts the call and throws TimedOut into the script',
    () =>
      Effect.gen(function* () {
        const { host, stats } = fakeHost();
        const result = yield* run(
          `
try {
  yield* timeout(agent('stuck', { delayMs: 5000 }), 30)
} catch (error) {
  return error.name
}`,
          host,
        );
        expect(result).toBe('TimedOut');
        expect(stats.interrupted).toEqual(['stuck']);
      }),
  );

  it.live('multi-step branches run concurrently as their own fibers', () =>
    Effect.gen(function* () {
      const { host, stats } = fakeHost(4);
      const result = yield* run(
        `
return yield* forEach(['intro', 'results'], (section) => function* () {
  const draft = yield* agent('draft ' + section, { delayMs: 20 })
  const polished = yield* agent('polish ' + draft.response, { delayMs: 20 })
  return polished.response
})`,
        host,
      );
      expect(result).toEqual([
        'result:polish result:draft intro',
        'result:polish result:draft results',
      ]);
      expect(stats.peak).toBe(2);
    }),
  );

  it.live('interrupting the run interrupts every in-flight agent call', () =>
    Effect.gen(function* () {
      const { host, stats } = fakeHost();
      const started = yield* Deferred.make<void>();
      const gated: WorkflowHost<never> = {
        ...host,
        runAgent: (call) =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(host.runAgent(call)),
          ),
      };
      const fiber = yield* Effect.forkChild(
        run(
          `return yield* all([agent('a', { delayMs: 5000 }), agent('b', { delayMs: 5000 })])`,
          gated,
        ),
      );
      yield* Deferred.await(started);
      yield* Effect.sleep(10);
      yield* Fiber.interrupt(fiber);
      expect([...stats.interrupted].sort()).toEqual(['a', 'b']);
    }),
  );

  it.effect('a synchronous infinite loop between yields is preempted', () =>
    Effect.gen(function* () {
      const { host } = fakeHost();
      const exit = yield* Effect.exit(
        runWorkflow(`yield* agent('x'); while (true) {}`, {
          ...host,
          stepBudgetMs: 50,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain('CPU budget');
    }),
  );

  it.effect('the preemption cannot be caught by the script', () =>
    Effect.gen(function* () {
      const { host } = fakeHost();
      const exit = yield* Effect.exit(
        runWorkflow(`try { while (true) {} } catch (e) { return 'caught' }`, {
          ...host,
          stepBudgetMs: 50,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect('an async-format script fails with a pointed hint', () =>
    Effect.gen(function* () {
      const { host } = fakeHost();
      const exit = yield* Effect.exit(run(`return await agent('x')`, host));
      expect(JSON.stringify(exit)).toContain('yield* agent');
    }),
  );

  it.effect('yielding something that is not an operation fails clearly', () =>
    Effect.gen(function* () {
      const { host } = fakeHost();
      const exit = yield* Effect.exit(run(`yield 42`, host));
      expect(JSON.stringify(exit)).toContain('yield* expects an operation');
    }),
  );

  it.effect('the host is unreachable and determinism guards hold', () =>
    Effect.gen(function* () {
      const { host } = fakeHost();
      const result = yield* run(
        `
const probes = {}
const tryIt = (name, f) => { try { probes[name] = String(f()) } catch (e) { probes[name] = 'blocked' } }
tryIt('process', () => typeof process)
tryIt('require', () => typeof require)
tryIt('Function', () => Function('return 1')())
tryIt('ctor', () => agent.constructor('return globalThis')())
tryIt('genCtor', () => (function* () {}).constructor('yield 1'))
tryIt('random', () => Math.random())
tryIt('now', () => Date.now())
return probes`,
        host,
      );
      expect(result).toEqual({
        process: 'undefined',
        require: 'undefined',
        Function: 'blocked',
        ctor: 'blocked',
        genCtor: 'blocked',
        random: 'blocked',
        now: 'blocked',
      });
    }),
  );

  it.effect('an uncaught script error fails the run with its own name', () =>
    Effect.gen(function* () {
      const { host } = fakeHost();
      const exit = yield* Effect.exit(
        run(`throw new RangeError('bad input')`, host),
      );
      expect(JSON.stringify(exit)).toContain('RangeError');
    }),
  );
});
