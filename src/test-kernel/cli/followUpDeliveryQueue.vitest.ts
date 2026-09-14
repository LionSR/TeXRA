// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber, Scope } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import { makeFollowUpDeliveryQueue } from '@cli/chat/followUpDeliveryQueue';

describe('follow-up delivery queue', () => {
  it.effect(
    'delivers one at a time, drops only unstarted deliveries on clear, and idles after the running one settles',
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const queue = yield* makeFollowUpDeliveryQueue(scope);
        const delivered: string[] = [];
        const record = (label: string) =>
          Effect.sync(() => {
            delivered.push(label);
          });
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();

        queue.enqueue(
          record('first:start').pipe(
            Effect.andThen(Deferred.succeed(firstStarted, undefined)),
            Effect.andThen(Deferred.await(releaseFirst)),
            Effect.andThen(record('first:end')),
          ),
        );
        queue.enqueue(record('dropped'));
        yield* Deferred.await(firstStarted);
        queue.clear();
        queue.enqueue(record('after-clear'));
        const idle = yield* queue.idle.pipe(
          Effect.andThen(record('idle')),
          Effect.forkChild,
        );

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Fiber.join(idle);

        expect(delivered).toEqual([
          'first:start',
          'first:end',
          'after-clear',
          'idle',
        ]);
        yield* Scope.close(scope, Exit.void);
      }),
  );
});
