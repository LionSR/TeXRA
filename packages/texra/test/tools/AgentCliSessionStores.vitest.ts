// Failure modes: concurrent calls claim the same thread; closing a rejected
// call frees a live claim; a finished claim prevents the next turn.

// Third-party imports
import { it } from '@effect/vitest';
import { Context, Effect, Exit, Fiber, Layer, Scheduler, Scope } from 'effect';
import { assert, expect } from 'vitest';

// Local imports
import { PluginHold } from '@texra-ai/harness/plugins';
import {
  CodexThreads,
  codexThreadsLayer,
} from '@texra/tools/agentCli/agentCliSessionStores';

it.effect('keeps one claim until its turn closes it', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(codexThreadsLayer).pipe(
        // This boundary checks claims, without a plugin catalog to retain.
        Effect.provideService(PluginHold, () => Effect.void),
      );
      const claim = Context.get(services, CodexThreads);
      // Vary preceding work so the scheduler can yield during acquisition,
      // without inserting a yield into the implementation under test.
      for (let padding = 0; padding < 32; padding++) {
        const claims = yield* Effect.gen(function* () {
          const a = yield* Effect.forkScoped(
            Effect.gen(function* () {
              for (let i = 0; i < padding; i++) yield* Effect.sync(() => {});
              return yield* Effect.uninterruptible(claim('thread'));
            }),
          );
          const b = yield* Effect.forkScoped(
            Effect.uninterruptible(claim('thread')),
          );
          return [yield* Fiber.join(a), yield* Fiber.join(b)];
        }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 32));
        const held = claims.filter((value) => value !== undefined);
        yield* Effect.addFinalizer(() =>
          Effect.forEach(held, (scope) => Scope.close(scope, Exit.void)),
        );
        expect(held).toHaveLength(1);
        const [first] = held;
        assert(first !== undefined);
        expect(yield* claim('thread')).toBeUndefined();
        yield* Scope.close(first, Exit.void);
        const next = yield* claim('thread');
        assert(next !== undefined);
        yield* Scope.close(next, Exit.void);
      }
    }),
  ),
);
