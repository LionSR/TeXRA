import { E } from './load.mjs';
const {
  Effect,
  Fiber,
  FiberHandle,
  FiberMap,
  FiberSet,
  Scope,
  Exit,
  Option,
  Scheduler,
  Semaphore,
  Deferred,
  Cause,
} = E;
const out = {};
const slowClose = (log, id, ms) =>
  Effect.never.pipe(
    Effect.onInterrupt(() =>
      Effect.andThen(
        Effect.sleep(ms),
        Effect.sync(() => {
          log.push(`released ${id}`);
        }),
      ),
    ),
  );
const t = () => Date.now();
// FiberHandle: replace overlaps; onlyIfMissing drops; clear waits; scope close waits
out.handle = await Effect.runPromise(
  Effect.gen(function* () {
    const log = [];
    const scope = yield* Scope.make();
    const h = yield* FiberHandle.make().pipe(Scope.provide(scope));
    yield* FiberHandle.run(
      h,
      Effect.andThen(
        Effect.sync(() => {
          log.push('start A');
        }),
        slowClose(log, 'A', 40),
      ),
    );
    yield* Effect.sleep(2);
    yield* FiberHandle.run(
      h,
      Effect.andThen(
        Effect.sync(() => {
          log.push('start B');
        }),
        slowClose(log, 'B', 40),
      ),
    );
    yield* Effect.sleep(2);
    const dropped = yield* FiberHandle.run(
      h,
      Effect.sync(() => {
        log.push('start C');
      }),
      { onlyIfMissing: true },
    );
    const droppedExit = yield* Fiber.await(dropped);
    log.push(
      `C onlyIfMissing: ${Exit.isFailure(droppedExit) && Cause.hasInterruptsOnly(droppedExit.cause) ? 'interrupted, never ran' : 'ran'}`,
    );
    let t0 = t();
    yield* FiberHandle.clear(h);
    log.push(`clear waited ${t() - t0}ms`);
    yield* FiberHandle.run(h, slowClose(log, 'D', 200));
    yield* Effect.sleep(2);
    t0 = t();
    const bounded = yield* FiberHandle.clear(h).pipe(Effect.timeoutOption(30));
    log.push(
      `clear with timeoutOption(30): ${Option.isNone(bounded) ? 'gave up' : 'done'} after ${t() - t0}ms`,
    );
    yield* FiberHandle.run(h, slowClose(log, 'E', 120));
    yield* Effect.sleep(2);
    t0 = t();
    yield* Scope.close(scope, Exit.void);
    log.push(`scope close waited ${t() - t0}ms`);
    return log;
  }),
);
// scope close bounded by a deadline: timeout over an uninterruptible close?
out.boundedClose = await Effect.runPromise(
  Effect.gen(function* () {
    const log = [];
    const mk = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const set = yield* FiberSet.make().pipe(Scope.provide(scope));
      yield* FiberSet.run(set, slowClose(log, 'x', 150));
      yield* Effect.sleep(2);
      return { scope, set };
    });
    let s = yield* mk;
    let t0 = t();
    const r1 = yield* Scope.close(s.scope, Exit.void).pipe(
      Effect.timeoutOption(30),
    );
    log.push(
      `timeoutOption(30) over Scope.close: ${Option.isNone(r1) ? 'none' : 'some'} after ${t() - t0}ms`,
    );
    s = yield* mk;
    t0 = t();
    const f = yield* Effect.forkDetach(Scope.close(s.scope, Exit.void));
    const r2 = yield* Fiber.join(f).pipe(Effect.timeoutOption(30));
    log.push(
      `join of a forked close with timeoutOption(30): ${Option.isNone(r2) ? 'none' : 'some'} after ${t() - t0}ms`,
    );
    s = yield* mk;
    t0 = t();
    const r3 = yield* FiberSet.clear(s.set).pipe(
      Effect.andThen(FiberSet.awaitEmpty(s.set)),
      Effect.timeoutOption(30),
    );
    log.push(
      `clear+awaitEmpty with timeoutOption(30): ${Option.isNone(r3) ? 'none' : 'some'} after ${t() - t0}ms`,
    );
    yield* Effect.sleep(200);
    return log;
  }),
);
// FiberMap: run same key replaces without waiting; onlyIfMissing; awaitEmpty
out.map = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const log = [];
      const m = yield* FiberMap.make();
      yield* FiberMap.run(
        m,
        'k',
        Effect.andThen(
          Effect.sync(() => {
            log.push('start 1');
          }),
          slowClose(log, '1', 30),
        ),
      );
      yield* Effect.sleep(2);
      yield* FiberMap.run(
        m,
        'k',
        Effect.andThen(
          Effect.sync(() => {
            log.push('start 2');
          }),
          Effect.sleep(50),
        ),
      );
      yield* Effect.sleep(2);
      const size = yield* FiberMap.size(m);
      const t0 = t();
      yield* FiberMap.awaitEmpty(m);
      log.push(`awaitEmpty waited ${t() - t0}ms, size before ${size}`);
      return log;
    }),
  ),
);
// Semaphore.withPermitsIfAvailable is one step: at budget 2, exactly one of many simultaneous callers gets Some
let multi = 0,
  runs = 0;
for (const budget of [2, 3, 5, 8])
  for (let r = 0; r < 50; r++) {
    await Effect.runPromise(
      Effect.gen(function* () {
        const s = Semaphore.makeUnsafe(1);
        let inside = 0,
          max = 0;
        const body = Effect.gen(function* () {
          inside++;
          max = Math.max(max, inside);
          yield* Effect.yieldNow;
          yield* Effect.sleep(1);
          inside--;
        });
        const rs = yield* Effect.all(
          Array.from({ length: 8 }, (_, i) =>
            Effect.andThen(
              Effect.forEach(
                Array.from({ length: (i * r) % 5 }),
                () => Effect.void,
                { discard: true },
              ),
              s.withPermitsIfAvailable(1)(body),
            ),
          ),
          { concurrency: 'unbounded' },
        );
        runs++;
        if (max > 1) multi++;
        // interruption releases
        const f = yield* Effect.forkChild(
          s.withPermitsIfAvailable(1)(Effect.never),
        );
        yield* Effect.sleep(1);
        yield* Fiber.interrupt(f);
        const again = yield* s.withPermitsIfAvailable(1)(Effect.succeed('ok'));
        if (Option.isNone(again)) multi += 1000;
      }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, budget)),
    );
  }
out.tryAndRefuse = { runs, runsWithTwoHolders: multi };
console.log(JSON.stringify(out, null, 1));
