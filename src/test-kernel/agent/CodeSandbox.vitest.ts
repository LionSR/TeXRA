// The code sandbox runs one script on a real worker thread, bundled the way
// every host embeds it. Failure modes this suite guards, written before the
// implementation:
//
// 1. Settlement order leaks into issue numbering nondeterministically: under
//    `Promise.all`, chained awaits and try/catch, the same delivery order must
//    issue the same ops with the same numbers, and a different order must
//    issue exactly what that order implies.
// 2. Interrupting the caller leaves the worker running, or waits out the
//    close timeout, while the guest spins in a loop that never awaits.
// 3. The CPU budget or the heap limit trips as an untyped failure, or not at
//    all.
// 4. The wall deadline does not end a script that waits on the host forever.
// 5. A malformed worker message is trusted instead of failing its decode.
// 6. A call that dies leaves the script waiting out its deadline (review of
//    #13601).

import { it } from '@effect/vitest';
import * as NodeWorker from '@effect/platform-node/NodeWorker';
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Layer } from 'effect';
import * as Worker from 'effect/workers/Worker';
import { expect } from 'vitest';

import {
  CodeSandbox,
  type ScriptOp,
  type ScriptSettlement,
} from '@agent/codeSandbox/codeSandbox';
import type { Worker as WorkerThread } from 'node:worker_threads';

const SandboxLayer = CodeSandbox.layer.pipe(
  Layer.provide(NodeWorker.layerPlatform),
);

const ORDER_SCRIPT = `
const left = tools.echo({ v: 'a' }).then((r) => tools.echo({ v: r.v + '1' }));
const right = tools.echo({ v: 'b' }).then((r) => tools.echo({ v: r.v + '2' }));
let caught = null;
phase('Check');
try {
  await tools.fail({});
} catch (error) {
  caught = error.name + ': ' + error.message;
}
console.log('caught', caught);
const [l, r] = await Promise.all([left, right]);
return { l: l.v, r: r.v, caught };
`;

const answer = (op: ScriptOp): ScriptSettlement =>
  op.name === 'fail'
    ? { _tag: 'Failure', name: 'ToolFailed', message: 'nope' }
    : { _tag: 'Value', value: op.input };

/**
 * Runs ORDER_SCRIPT, completing calls in `releaseOrder` (by op number), and
 * returns every op the guest issued with the script's result.
 */
const runInOrder = (releaseOrder: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    const sandbox = yield* CodeSandbox;
    const issued = new Map<number, Deferred.Deferred<ScriptOp>>();
    const answers = new Map<number, Deferred.Deferred<ScriptSettlement>>();
    const slot = <A>(slots: Map<number, Deferred.Deferred<A>>, seq: number) => {
      const existing = slots.get(seq);
      if (existing) return existing;
      const created = Deferred.makeUnsafe<A>();
      slots.set(seq, created);
      return created;
    };
    const ops: ScriptOp[] = [];
    const logs: string[] = [];
    yield* Effect.forkScoped(
      Effect.forEach(
        releaseOrder,
        (seq) =>
          Deferred.await(slot(issued, seq)).pipe(
            Effect.flatMap((op) =>
              Deferred.succeed(slot(answers, seq), answer(op)),
            ),
          ),
        { discard: true },
      ),
    );
    const result = yield* sandbox.run({
      source: ORDER_SCRIPT,
      tools: ['echo', 'fail'],
      timeout: '20 seconds',
      call: (op) =>
        Effect.suspend(() => {
          ops.push(op);
          return Deferred.succeed(slot(issued, op.seq), op).pipe(
            Effect.andThen(Deferred.await(slot(answers, op.seq))),
          );
        }),
      onLog: (lines) => Effect.sync(() => logs.push(...lines)),
    });
    return { ops, result, logs };
  });

// Live clock throughout: the deadlines under test are real time, and so is the
// worker on the other side of them.
it.layer(SandboxLayer, { excludeTestServices: true })('CodeSandbox', (it) => {
  it.effect(
    'numbers ops by the settlement order it is given, and only by that',
    () =>
      Effect.gen(function* () {
        const failFirst = yield* runInOrder([2, 1, 0, 3, 4]);
        const again = yield* runInOrder([2, 1, 0, 3, 4]);
        const inIssueOrder = yield* runInOrder([0, 1, 2, 3, 4]);

        // An op carries the phase the guest had entered when it issued it.
        const issuedBefore = [
          { seq: 0, name: 'echo', input: { v: 'a' }, phase: null },
          { seq: 1, name: 'echo', input: { v: 'b' }, phase: null },
          { seq: 2, name: 'fail', input: {}, phase: 'Check' },
        ];
        expect(failFirst.ops).toEqual([
          ...issuedBefore,
          { seq: 3, name: 'echo', input: { v: 'b2' }, phase: 'Check' },
          { seq: 4, name: 'echo', input: { v: 'a1' }, phase: 'Check' },
        ]);
        expect(again.ops).toEqual(failFirst.ops);
        expect(inIssueOrder.ops).toEqual([
          ...issuedBefore,
          { seq: 3, name: 'echo', input: { v: 'a1' }, phase: 'Check' },
          { seq: 4, name: 'echo', input: { v: 'b2' }, phase: 'Check' },
        ]);
        for (const run of [failFirst, again, inIssueOrder]) {
          expect(run.result).toEqual({
            value: { l: 'a1', r: 'b2', caught: 'ToolFailed: nope' },
          });
          expect(run.logs).toEqual(['caught ToolFailed: nope']);
        }
      }),
  );

  it.effect(
    'interrupting the caller ends the worker without waiting out a busy loop',
    () =>
      Effect.gen(function* () {
        const sandbox = yield* CodeSandbox;
        const spawned = yield* Deferred.make<WorkerThread>();
        const onWorker = (thread: WorkerThread) =>
          Deferred.doneUnsafe(spawned, Effect.succeed(thread));
        yield* Effect.acquireRelease(
          Effect.sync(() => process.on('worker', onWorker)),
          () => Effect.sync(() => process.off('worker', onWorker)),
        );
        const fiber = yield* Effect.forkChild(
          sandbox.run({
            source: 'while (true) {}',
            tools: [],
            timeout: '1 minute',
            call: () => Effect.never,
          }),
        );
        const thread = yield* Deferred.await(spawned);
        // Let the guest reach its loop.
        yield* Effect.sleep('300 millis');

        const start = yield* Clock.currentTimeMillis;
        yield* Fiber.interrupt(fiber);
        const elapsed = (yield* Clock.currentTimeMillis) - start;

        // The worker's close is graceful only because the guest is preempted;
        // otherwise the platform waits 5 s before terminating it.
        expect(elapsed).toBeLessThan(2_000);
        expect(thread.threadId).toBe(-1);
      }),
  );

  it.effect('a call that dies ends the run with its defect at once', () =>
    Effect.gen(function* () {
      const sandbox = yield* CodeSandbox;
      // A BigInt does not serialize, so delivering this settlement dies.
      const exit = yield* sandbox
        .run({
          source: 'return await tools.big({});',
          tools: ['big'],
          timeout: '1 minute',
          call: () => Effect.succeed({ _tag: 'Value', value: 1n }),
        })
        .pipe(Effect.timeout('5 seconds'), Effect.exit);
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    }),
  );

  it.effect('a loop that never awaits trips the CPU budget', () =>
    Effect.gen(function* () {
      const sandbox = yield* CodeSandbox;
      const error = yield* sandbox
        .run({
          source: 'while (true) {}',
          tools: [],
          timeout: '1 minute',
          cpuBudgetMs: 200,
          call: () => Effect.never,
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: 'ScriptCpuExhausted',
        budgetMs: 200,
      });
    }),
  );

  it.effect('allocating past the heap limit trips the memory limit', () =>
    Effect.gen(function* () {
      const sandbox = yield* CodeSandbox;
      const error = yield* sandbox
        .run({
          source: 'const xs = []; for (;;) xs.push(new ArrayBuffer(8 << 20));',
          tools: [],
          timeout: '1 minute',
          call: () => Effect.never,
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe('ScriptMemoryExhausted');
    }),
  );

  it.effect('the wall deadline ends a script that waits forever', () =>
    Effect.gen(function* () {
      const sandbox = yield* CodeSandbox;
      const error = yield* sandbox
        .run({
          source: 'await tools.wait({});',
          tools: ['wait'],
          timeout: '300 millis',
          call: () => Effect.never,
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe('ScriptTimedOut');
    }),
  );

  it.effect('a syntax error names its line and column in the script', () =>
    Effect.gen(function* () {
      const sandbox = yield* CodeSandbox;
      const errors = yield* Effect.forEach(
        ['const a = 1;\nconst b = ;', 'import x from "y";'],
        (source) =>
          sandbox
            .run({
              source,
              tools: [],
              timeout: '1 minute',
              call: () => Effect.never,
            })
            .pipe(Effect.flip),
      );
      expect(errors.map((error) => [error._tag, error.message])).toEqual([
        [
          'ScriptSyntaxError',
          "unexpected token in expression: ';' (line 2, column 11)",
        ],
        ['ScriptSyntaxError', "expecting '(' (line 1, column 8)"],
      ]);
    }),
  );
});

/** The real worker platform, with every message from the worker replaced. */
const CorruptingPlatform = Layer.effect(Worker.WorkerPlatform)(
  Effect.gen(function* () {
    const platform = yield* Worker.WorkerPlatform;
    return Worker.WorkerPlatform.of({
      spawn: <O, I>(id: number) =>
        Effect.map(platform.spawn<O, I>(id), (worker): Worker.Worker<O, I> => ({
          send: worker.send,
          run: (handler, options) =>
            worker.run(
              () => handler({ ops: 'not ops' } as unknown as O),
              options,
            ),
        })),
    });
  }),
).pipe(Layer.provide(NodeWorker.layerPlatform));

it.effect(
  'a worker message that fails its decode makes the sandbox unavailable',
  () =>
    Effect.gen(function* () {
      const sandbox = yield* CodeSandbox;
      const error = yield* sandbox
        .run({
          source: 'return 1;',
          tools: [],
          timeout: '20 seconds',
          call: () => Effect.never,
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe('SandboxUnavailable');
      expect(error.message).toContain('malformed message');
    }).pipe(
      Effect.provide(CodeSandbox.layer.pipe(Layer.provide(CorruptingPlatform))),
    ),
  30_000,
);
