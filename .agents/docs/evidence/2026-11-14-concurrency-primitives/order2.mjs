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
  let m3 = 0,
    m3runs = 0;
  for (const budget of [2, 3, 5, 8, 13, 21, 34, 55, 79]) {
    for (let off = 0; off < 25; off++) {
      await run(
        Effect.gen(function* () {
          const lane = mk();
          const entered = [];
          const gate = Deferred.makeUnsafe();
          let started = 0;
          const holder = yield* Effect.forkChild(lane(Deferred.await(gate)));
          yield* Effect.sleep(2);
          const fibers = [];
          for (let i = 0; i < N; i++) {
            fibers.push(
              yield* Effect.forkChild(
                Effect.andThen(
                  noops((off * (i + 1)) % 9),
                  Effect.suspend(() => {
                    started++;
                    return lane(
                      Effect.suspend(() => {
                        entered.push(i);
                        return noops((off + i) % 5);
                      }),
                    );
                  }),
                ),
              ),
            );
            while (started < i + 1) yield* Effect.sleep(1);
            yield* Effect.sleep(4); // the join is at most ~20 steps after the marker
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
  res[name] = `${m3}/${m3runs}`;
}
console.log(
  'queued in known order, then released; runs where entry order differs:',
  res,
);
