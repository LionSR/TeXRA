import { E } from './load.mjs';
const { Effect, TxRef, TxHashMap, Fiber, Scheduler } = E;
const run = (eff, budget) =>
  Effect.runPromise(
    Effect.provideService(eff, Scheduler.MaxOpsBeforeYield, budget),
  );
const noops = (n) =>
  n === 0
    ? Effect.void
    : Effect.forEach(Array.from({ length: n }), () => Effect.void, {
        discard: true,
      });
let late = 0,
  runs = 0,
  conflicts = 0,
  outOfOrder = 0,
  orderRuns = 0;
for (let budget = 2; budget <= 79; budget++) {
  for (let closeAt = 0; closeAt < 30; closeAt += 3) {
    await run(
      Effect.gen(function* () {
        const closed = yield* TxRef.make(false);
        const reg = yield* TxHashMap.empty();
        let sizeAtClose = -1;
        const register = (i) =>
          Effect.tx(
            Effect.gen(function* () {
              const t = yield* Effect.Transaction;
              if (t.attempt > 1) conflicts++;
              if (yield* TxRef.get(closed)) return false;
              yield* noops(i % 7);
              yield* TxHashMap.set(reg, i, true);
              return true;
            }),
          );
        const close = Effect.tx(
          Effect.gen(function* () {
            yield* TxRef.set(closed, true);
            yield* noops(3);
            return yield* TxHashMap.size(reg);
          }),
        ).pipe(
          Effect.tap((n) =>
            Effect.sync(() => {
              sizeAtClose = n;
            }),
          ),
        );
        const fibers = [];
        for (let i = 0; i < 30; i++) {
          fibers.push(
            yield* Effect.forkChild(Effect.andThen(noops(i % 13), register(i))),
          );
          if (i === closeAt)
            fibers.push(
              yield* Effect.forkChild(Effect.andThen(noops(5), close)),
            );
        }
        yield* Fiber.joinAll(fibers);
        runs++;
        if ((yield* TxHashMap.size(reg)) !== sizeAtClose) late++;
      }),
      budget,
    );
  }
  // commit order vs start order: six fibers, each claims as its first op; offsets differ per fiber
  for (let off = 0; off < 25; off++) {
    await run(
      Effect.gen(function* () {
        const list = yield* TxRef.make([]);
        const started = [];
        const fibers = [];
        for (let i = 0; i < 6; i++) {
          fibers.push(
            yield* Effect.forkChild(
              Effect.andThen(
                noops((off * (i + 1)) % 9),
                Effect.suspend(() => {
                  started.push(i);
                  return TxRef.update(list, (l) => [...l, i]);
                }),
              ),
            ),
          );
        }
        yield* Fiber.joinAll(fibers);
        orderRuns++;
        const committed = yield* TxRef.get(list);
        if (committed.join() !== started.join()) outOfOrder++;
      }),
      budget,
    );
  }
}
console.log({
  closeRuns: runs,
  registrationsAfterClose: late,
  retriesOnConflict: conflicts,
  orderRuns,
  commitOrderDiffersFromStartOrder: outOfOrder,
});
