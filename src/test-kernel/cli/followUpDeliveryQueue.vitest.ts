// Third-party imports
import { it } from '@effect/vitest';
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from 'effect';
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

  // Only the scope's close stops the drain: a delivery that ended
  // interrupted (a joined fiber someone else interrupted, or a finalizer
  // that failed while one unwound) is not the drain's own interruption.
  it.effect.each([
    { label: 'defects', cause: Cause.die('boom') },
    { label: 'ends interrupted', cause: Cause.interrupt(1) },
    {
      label: 'ends interrupted with a defect',
      cause: Cause.combine(Cause.interrupt(1), Cause.die('boom')),
    },
  ])(
    'keeps draining after a delivery $label so idle can still open',
    ({ cause }) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const queue = yield* makeFollowUpDeliveryQueue(scope);
        const delivered: string[] = [];
        queue.enqueue(Effect.failCause(cause));
        queue.enqueue(
          Effect.sync(() => {
            delivered.push('after-defect');
          }),
        );
        yield* queue.idle;
        expect(delivered).toEqual(['after-defect']);
        yield* Scope.close(scope, Exit.void);
      }),
  );
});
