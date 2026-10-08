// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Exit, Layer, Option, SubscriptionRef } from 'effect';
import { expect } from 'vitest';

// Local imports - real catalog and shared host edges
import { AppState } from '@platform/interfaces';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { fakeHostAppState } from '@test/support/setupPlatform';
import { LiveTools, toolTableLayer } from '@tools/liveTools';
import { ALWAYS_AVAILABLE } from '@tools/toolProbes';
import { toolTable } from '@tools/toolTable';

// Failure mode: failed reconciliation leaks its contribution and cached
// defect, leaving unusable tools published and poisoning subsequent readers.
it.effect(
  'failed reconciliation withdraws the incomplete plugin and permits a fresh build',
  () => {
    const failure = new Error('plugin layer failed');
    let failed = false;
    const table = toolTable([
      {
        id: 'failed-plugin',
        availability: ALWAYS_AVAILABLE,
        tools: {
          probe: {
            definition: { name: 'probe' },
            call: () => Effect.die('not called'),
          },
        },
        processLayer: {
          layer: Layer.effectDiscard(
            Effect.suspend(() => {
              if (failed) return Effect.void;
              failed = true;
              return Effect.die(failure);
            }),
          ),
        },
      },
    ]);
    return Effect.gen(function* () {
      const live = yield* LiveTools;
      expect(
        yield* Effect.exit(
          Effect.scoped(live.pinSwitched(Effect.succeed(new Set()))),
        ),
      ).toStrictEqual(Exit.die(failure));
      expect([
        ...(yield* SubscriptionRef.get(live.registry.current)).entries.keys(),
      ]).toEqual([]);
      expect(
        yield* Effect.scoped(live.processServices('failed-plugin')),
      ).toEqual(Option.none());
      const retried = yield* live.pinSwitched(Effect.succeed(new Set()));
      expect([...retried.generation.entries.keys()]).toEqual(['probe']);
      expect(
        Option.isSome(
          yield* Effect.scoped(live.processServices('failed-plugin')),
        ),
      ).toBe(true);
    }).pipe(
      Effect.provide(
        toolTableLayer(table, undefined, new Set(['failed-plugin'])).pipe(
          Layer.provide(
            Layer.mergeAll(nodePlatformLayer, AppState.layer(fakeHostAppState)),
          ),
        ),
      ),
    );
  },
);
