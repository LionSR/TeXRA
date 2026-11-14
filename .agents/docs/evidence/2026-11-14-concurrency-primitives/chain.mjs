import { E } from './load.mjs';
const { Effect, Deferred } = E;
// copy of packages/harness/src/utils/core/perKeyQueue.ts (withPerKeyLane), types removed
export function withPerKeyLane(lanes, key) {
  return (self) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const existing = lanes.get(key);
        const mine = Deferred.makeUnsafe();
        const previous = existing?.tail;
        const held = existing ?? { tail: mine, fibers: 0 };
        if (!existing) lanes.set(key, held);
        held.tail = mine;
        held.fibers += 1;
        let entered = previous === undefined;
        const run =
          previous === undefined
            ? self
            : Effect.flatMap(Deferred.await(previous), () => {
                entered = true;
                return self;
              });
        return restore(run).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              Deferred.doneUnsafe(
                mine,
                previous === undefined || entered
                  ? Effect.void
                  : Deferred.await(previous),
              );
              held.fibers -= 1;
              if (held.fibers === 0 && lanes.get(key) === held)
                lanes.delete(key);
            }),
          ),
        );
      }),
    );
}
