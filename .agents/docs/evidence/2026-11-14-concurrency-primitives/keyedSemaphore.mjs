// A keyed lane as a Map of semaphores with a holder count, against the
// hand-written Deferred chain (chain.mjs): order, exclusion, release under
// interruption, and pruning.
import { E } from './load.mjs';
import { withPerKeyLane as chain } from './chain.mjs';
const { Effect, Fiber, Scheduler, Semaphore } = E;

const keyed = (lanes, key) => (self) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const lane = lanes.get(key) ?? {
        lock: Semaphore.makeUnsafe(1),
        fibers: 0,
      };
      lanes.set(key, lane);
      lane.fibers += 1;
      return lane;
    }),
    (lane) => lane.lock.withPermit(self),
    (lane) =>
      Effect.sync(() => {
        lane.fibers -= 1;
        if (lane.fibers === 0 && lanes.get(key) === lane) lanes.delete(key);
      }),
  );

const noops = (n) =>
  n === 0
    ? Effect.void
    : Effect.forEach(Array.from({ length: n }), () => Effect.void, {
        discard: true,
      });

// 1. Default budget: offsets where a later caller enters first.
const offsets = async (make) => {
  let reordered = 0;
  for (let k = 0; k <= 2100; k++) {
    await Effect.runPromise(
      Effect.gen(function* () {
        const lane = make();
        const started = [];
        const entered = [];
        const call = (i) =>
          Effect.suspend(() => {
            started.push(i);
            return lane(Effect.sync(() => entered.push(i)));
          });
        const a = yield* Effect.forkChild(Effect.andThen(noops(k), call('a')));
        const b = yield* Effect.forkChild(call('b'));
        yield* Fiber.joinAll([a, b]);
        if (started.join() !== entered.join()) reordered++;
      }),
    );
  }
  return reordered;
};

// 2. Budgets 2..79: six fibers, order from the calling step; overlap; what is left in the map.
const small = async (make, lanes) => {
  let reordered = 0;
  let runs = 0;
  let overlap = 0;
  let left = 0;
  for (let budget = 2; budget <= 79; budget++) {
    for (let off = 0; off < 3; off++) {
      await Effect.runPromise(
        Effect.gen(function* () {
          const map = lanes();
          const lane = make(map);
          const started = [];
          const entered = [];
          let inside = 0;
          const fibers = [];
          for (let i = 0; i < 6; i++)
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
                          Effect.sync(() => inside--),
                        );
                      }),
                    );
                  }),
                ),
              ),
            );
          yield* Fiber.joinAll(fibers);
          runs++;
          if (started.join() !== entered.join()) reordered++;
          left += map.size;
        }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, budget)),
      );
    }
  }
  return { reordered: `${reordered}/${runs}`, overlap, left };
};

// 3. A claimant interrupted at every step, budget 8: is the key ever left held?
const leak = async (make) => {
  let leaked = 0;
  for (let padding = 0; padding < 40; padding++) {
    const map = new Map();
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        yield* noops(padding);
        yield* make(map)(Effect.void);
      }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 8)),
    );
    await Effect.runPromise(Fiber.interrupt(fiber));
    if (map.size > 0) leaked++;
  }
  return leaked;
};

console.log('default budget, offsets 0..2100 where entry order != call order', {
  chain: await offsets(() => {
    const m = new Map();
    return chain(m, 'k');
  }),
  keyedSemaphore: await offsets(() => {
    const m = new Map();
    return keyed(m, 'k');
  }),
});
console.log('budgets 2..79', {
  chain: await small(
    (m) => chain(m, 'k'),
    () => new Map(),
  ),
  keyedSemaphore: await small(
    (m) => keyed(m, 'k'),
    () => new Map(),
  ),
});
console.log('interrupted at each of 40 steps, keys left held', {
  chain: await leak((m) => chain(m, 'k')),
  keyedSemaphore: await leak((m) => keyed(m, 'k')),
});
