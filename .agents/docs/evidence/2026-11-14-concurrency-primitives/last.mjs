import { E } from './load.mjs';
import { withPerKeyLane } from './chain.mjs';
const {
  Effect,
  Fiber,
  Scheduler,
  Semaphore,
  RcMap,
  Ref,
  SubscriptionRef,
  TxRef,
  Deferred,
} = E;
const noops = (n) =>
  n === 0
    ? Effect.void
    : Effect.forEach(Array.from({ length: n }), () => Effect.void, {
        discard: true,
      });
// 1. PreventSchedulerYield around a region at budget 2
const region = (log, id, inner) =>
  Effect.gen(function* () {
    log.push(`${id}>`);
    yield* noops(6);
    yield* inner;
    yield* noops(6);
    log.push(`<${id}`);
  });
const interleaved = (log) => log.join(' ') !== 'a> <a b> <b c> <c';
const trial = (wrap, inner = Effect.void) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const log = [];
      yield* Effect.all(
        ['a', 'b', 'c'].map((id) => wrap(region(log, id, inner))),
        { concurrency: 'unbounded' },
      );
      return interleaved(log);
    }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 2)),
  );
const prevent = (e) =>
  Effect.provideService(e, Scheduler.PreventSchedulerYield, true);
console.log('budget 2, interleaved?', {
  plain: await trial((e) => e),
  preventYield: await trial(prevent),
  'preventYield + yieldNow inside': await trial(prevent, Effect.yieldNow),
  'preventYield + sleep(0) inside': await trial(prevent, Effect.sleep(0)),
  'preventYield + SubscriptionRef.update inside': await trial(
    prevent,
    Effect.flatMap(SubscriptionRef.make(0), (r) =>
      SubscriptionRef.update(r, (n) => n + 1),
    ),
  ),
  'preventYield + Effect.tx inside': await trial(
    prevent,
    Effect.flatMap(TxRef.make(0), (r) => TxRef.update(r, (n) => n + 1)),
  ),
});
// 2. default budget: at how many op offsets does a later caller enter first? (marker = the step that calls the lane)
const offsets = async (mkLane) => {
  let reordered = 0;
  for (let k = 0; k <= 2100; k++) {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lane = yield* mkLane;
          const started = [],
            entered = [];
          const call = (i) =>
            Effect.suspend(() => {
              started.push(i);
              return lane(
                Effect.sync(() => {
                  entered.push(i);
                }),
              );
            });
          const a = yield* Effect.forkChild(
            Effect.andThen(noops(k), call('a')),
          );
          const b = yield* Effect.forkChild(call('b'));
          yield* Fiber.joinAll([a, b]);
          if (started.join() !== entered.join()) reordered++;
        }),
      ),
    );
  }
  return reordered;
};
console.log('default budget, offsets 0..2100 where entry order != call order', {
  chain: await offsets(
    Effect.sync(() => {
      const m = new Map();
      return (self) => withPerKeyLane(m, 'k')(self);
    }),
  ),
  Semaphore: await offsets(
    Effect.sync(() => {
      const s = Semaphore.makeUnsafe(1);
      return (self) => s.withPermit(self);
    }),
  ),
  'RcMap<key, Semaphore>': await offsets(
    Effect.map(
      RcMap.make({ lookup: () => Semaphore.make(1) }),
      (m) => (self) =>
        Effect.scoped(
          Effect.flatMap(RcMap.get(m, 'k'), (s) => s.withPermit(self)),
        ),
    ),
  ),
});
// 3. RcMap<key, Semaphore>: exclusion and pruning
console.log(
  'RcMap<key,Semaphore>',
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const m = yield* RcMap.make({ lookup: () => Semaphore.make(1) });
        const lane = (key) => (self) =>
          Effect.scoped(
            Effect.flatMap(RcMap.get(m, key), (s) => s.withPermit(self)),
          );
        let inside = 0,
          max = 0;
        const body = Effect.gen(function* () {
          inside++;
          max = Math.max(max, inside);
          yield* Effect.sleep(1);
          inside--;
        });
        yield* Effect.all(
          Array.from({ length: 20 }, () => lane('k')(body)),
          { concurrency: 'unbounded' },
        ).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 3));
        const f = yield* Effect.forkChild(lane('k')(Effect.never));
        yield* Effect.sleep(2);
        yield* Fiber.interrupt(f);
        const t0 = process.hrtime.bigint();
        yield* Effect.forEach(
          Array.from({ length: 50000 }),
          () => lane('k')(Effect.void),
          { discard: true },
        );
        const ns = Number(process.hrtime.bigint() - t0) / 50000;
        const map = new Map();
        const t1 = process.hrtime.bigint();
        yield* Effect.forEach(
          Array.from({ length: 50000 }),
          () => withPerKeyLane(map, 'k')(Effect.void),
          { discard: true },
        );
        const ns2 = Number(process.hrtime.bigint() - t1) / 50000;
        return {
          maxInside: max,
          keysAfterIdle: [...(yield* RcMap.keys(m))].length,
          nsPerUncontendedCall: Math.round(ns),
          chainNs: Math.round(ns2),
        };
      }),
    ),
  ),
);
