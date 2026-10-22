// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber, Scope } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import { makeFollowUpDeliveryQueue } from '@cli/chat/followUpDeliveryQueue';

describe('follow-up delivery queue', () => {
  it.effect(
    'delivers one at a time, drops only unstarted deliveries on clear (each settled by its own drop), and idles after the running one settles',
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const queue = yield* makeFollowUpDeliveryQueue(scope);
        const delivered: string[] = [];
        const record = (label: string) =>
          Effect.sync(() => {
            delivered.push(label);
          });
        const unexpectedDrop = () => void delivered.push('unexpected-drop');
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();

        queue.enqueue(
          record('first:start').pipe(
            Effect.andThen(Deferred.succeed(firstStarted, undefined)),
            Effect.andThen(Deferred.await(releaseFirst)),
            Effect.andThen(record('first:end')),
          ),
          unexpectedDrop,
        );
        queue.enqueue(record('dropped'), () =>
          delivered.push('dropped:settled'),
        );
        yield* Deferred.await(firstStarted);
        queue.clear();
        queue.enqueue(record('after-clear'), unexpectedDrop);
        const idle = yield* queue.idle.pipe(
          Effect.andThen(record('idle')),
          Effect.forkChild,
        );

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Fiber.join(idle);

        expect(delivered).toEqual([
          'first:start',
          'dropped:settled',
          'first:end',
          'after-clear',
          'idle',
        ]);
        yield* Scope.close(scope, Exit.void);
      }),
  );

  it.effect(
    'keeps draining after a delivery defects so idle can still open',
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const queue = yield* makeFollowUpDeliveryQueue(scope);
        const delivered: string[] = [];
        queue.enqueue(Effect.die('boom'), () => undefined);
        queue.enqueue(
          Effect.sync(() => {
            delivered.push('after-defect');
          }),
          () => undefined,
        );
        yield* queue.idle;
        expect(delivered).toEqual(['after-defect']);
        yield* Scope.close(scope, Exit.void);
      }),
  );
});
