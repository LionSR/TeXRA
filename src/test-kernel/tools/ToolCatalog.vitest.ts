// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Exit, Layer, Option, Stream } from 'effect';
import { expect } from 'vitest';

// Local imports - real catalog and shared host edges
import { AppState } from '@platform/interfaces';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { testRunRegistry } from '@test/support/runHandleFixtures';
import { fakeHostAppState } from '@test/support/setupPlatform';
import { ToolCatalog, toolCatalogLayer } from '@tools/liveTools';
import { ALWAYS_AVAILABLE } from '@tools/toolProbes';
import { toolTable } from '@tools/toolTable';

// Failure mode: a plugin layer whose build failed stays cached as a defect,
// poisoning every later step and borrower instead of building afresh.
it.effect(
  'a failed plugin layer is dropped, and the next step builds it afresh',
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
      const catalog = yield* ToolCatalog;
      const tools = yield* catalog.session(testRunRegistry);
      const services = Effect.scoped(
        Effect.flatMap(tools.pin(Effect.succeed(new Set())), (step) =>
          step.services(new Set(['failed-plugin'])),
        ),
      );
      expect(yield* Effect.exit(services)).toStrictEqual(Exit.die(failure));
      expect(
        yield* Effect.scoped(catalog.processServices('failed-plugin')),
      ).toEqual(Option.none());
      const step = yield* tools.pin(Effect.succeed(new Set()));
      expect([...step.entries.keys()]).toEqual(['probe']);
      yield* step.services(new Set(['failed-plugin']));
      expect(
        Option.isSome(
          yield* Effect.scoped(catalog.processServices('failed-plugin')),
        ),
      ).toBe(true);
    }).pipe(
      Effect.provide(
        toolCatalogLayer(table, { switches: Stream.never }).pipe(
          Layer.provide(
            Layer.mergeAll(nodePlatformLayer, AppState.layer(fakeHostAppState)),
          ),
        ),
      ),
    );
  },
);
