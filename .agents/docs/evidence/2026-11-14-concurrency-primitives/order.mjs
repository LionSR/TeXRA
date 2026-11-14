import { E } from './load.mjs';
import { withPerKeyLane } from './chain.mjs';
const {
  Effect,
  Fiber,
  Scheduler,
  Semaphore,
  PartitionedSemaphore,
  TxSemaphore,
  Deferred,
} = E;
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
const lanes = {
  chain: () => {
    const m = new Map();
    return (self) => withPerKeyLane(m, 'k')(self);
  },
  Semaphore: () => {
    const s = Semaphore.makeUnsafe(1);
    return (self) => s.withPermit(self);
  },
  PartitionedSemaphore: () => {
    const s = PartitionedSemaphore.makeUnsafe({ permits: 1 });
    return (self) => s.withPermit('k')(self);
  },
  TxSemaphore: () => {
    const s = Effect.runSync(TxSemaphore.make(1));
    return (self) => TxSemaphore.withPermit(s, self);
  },
};
const N = 6;
const res = {};
for (const [name, mk] of Object.entries(lanes)) {
  let m1 = 0,
    m1runs = 0,
    m3 = 0,
    m3runs = 0,
    overlap = 0;
  for (const budget of [2, 3, 5, 8, 13, 21, 34, 55, 79]) {
    for (let off = 0; off < 25; off++) {
      // M1: marker in the step that calls the lane; fibers have different phases
      await run(
        Effect.gen(function* () {
          const lane = mk();
          const started = [],
            entered = [];
          let inside = 0;
          const fibers = [];
          for (let i = 0; i < N; i++)
            fibers.push(
              yield* Effect.forkChild(
                Effect.andThen(
                  noops((off * (i + 1)) % 9),
                  Effect.suspend(() => {
                    started.push(i);
                    return lane(
                      Effect.suspend(() => {
                        entered.push(i);
                        if (++inside > 1) overlap++;
                        return Effect.andThen(
                          noops(i % 4),
                          Effect.sync(() => {
                            inside--;
                          }),
                        );
                      }),
                    );
                  }),
                ),
              ),
            );
          yield* Fiber.joinAll(fibers);
          m1runs++;
          if (started.join() !== entered.join()) m1++;
        }),
        budget,
      );
      // M3: holder holds; N fibers are queued one by one (each confirmed waiting); release; entry order?
      await run(
        Effect.gen(function* () {
          const lane = mk();
          const entered = [];
          const gate = Deferred.makeUnsafe();
          const holder = yield* Effect.forkChild(lane(Deferred.await(gate)));
          yield* Effect.sleep(1);
          const fibers = [];
          for (let i = 0; i < N; i++) {
            fibers.push(
              yield* Effect.forkChild(
                Effect.andThen(
                  noops((off * (i + 1)) % 9),
                  lane(
                    Effect.suspend(() => {
                      entered.push(i);
                      return noops((off + i) % 5);
                    }),
                  ),
                ),
              ),
            );
            yield* Effect.sleep(1);
          }
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.joinAll([holder, ...fibers]);
          m3runs++;
          if (entered.join() !== [0, 1, 2, 3, 4, 5].join()) m3++;
        }),
        budget,
      );
    }
  }
  // barging: the holder releases and re-acquires in its next steps while 3 fibers wait
  const barge = await Effect.runPromise(
    Effect.gen(function* () {
      const lane = mk();
      const entered = [];
      const gate = Deferred.makeUnsafe();
      const holder = yield* Effect.forkChild(
        Effect.andThen(
          lane(Deferred.await(gate)),
          lane(
            Effect.sync(() => {
              entered.push('holder-again');
            }),
          ),
        ),
      );
      yield* Effect.sleep(1);
      const fibers = [];
      for (let i = 0; i < 3; i++) {
        fibers.push(
          yield* Effect.forkChild(
            lane(
              Effect.sync(() => {
                entered.push(i);
              }),
            ),
          ),
        );
        yield* Effect.sleep(1);
      }
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.joinAll([holder, ...fibers]);
      return entered.join(',');
    }),
  );
  res[name] = {
    'M1 start-marker order broken': `${m1}/${m1runs}`,
    'M3 queued order broken': `${m3}/${m3runs}`,
    overlap,
    'release then re-acquire with 3 waiting': barge,
  };
}
console.log(res);
// PartitionedSemaphore is one pool, not a lock per key
console.log(
  'PartitionedSemaphore',
  await Effect.runPromise(
    Effect.gen(function* () {
      const one = PartitionedSemaphore.makeUnsafe({ permits: 1 });
      let inside = 0,
        maxAcrossKeys = 0;
      const body = Effect.gen(function* () {
        inside++;
        maxAcrossKeys = Math.max(maxAcrossKeys, inside);
        yield* Effect.sleep(5);
        inside--;
      });
      yield* Effect.all(
        [one.withPermit('a')(body), one.withPermit('b')(body)],
        { concurrency: 'unbounded' },
      );
      const two = PartitionedSemaphore.makeUnsafe({ permits: 2 });
      inside = 0;
      let maxSameKey = 0;
      const body2 = Effect.gen(function* () {
        inside++;
        maxSameKey = Math.max(maxSameKey, inside);
        yield* Effect.sleep(5);
        inside--;
      });
      yield* Effect.all(
        [two.withPermit('a')(body2), two.withPermit('a')(body2)],
        { concurrency: 'unbounded' },
      );
      // round robin across keys
      const rr = PartitionedSemaphore.makeUnsafe({ permits: 1 });
      const order = [];
      const gate = Deferred.makeUnsafe();
      const h = yield* Effect.forkChild(
        rr.withPermit('h')(Deferred.await(gate)),
      );
      yield* Effect.sleep(1);
      const fs = [];
      for (const k of ['a1', 'a2', 'a3', 'b1', 'c1']) {
        fs.push(
          yield* Effect.forkChild(
            rr.withPermit(k[0])(
              Effect.sync(() => {
                order.push(k);
              }),
            ),
          ),
        );
        yield* Effect.sleep(1);
      }
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.joinAll([h, ...fs]);
      return {
        'permits 1: max concurrent across keys a,b': maxAcrossKeys,
        'permits 2: max concurrent on same key': maxSameKey,
        'queued a1 a2 a3 b1 c1 enters as': order.join(' '),
      };
    }),
  ),
);
