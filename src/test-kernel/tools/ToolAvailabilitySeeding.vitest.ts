// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { afterEach, describe, expect } from 'vitest';

// Local imports
import { GlobalStateKey } from '@shared/state/stateKeys';
import { waitForCondition } from '@test/support/asyncTestUtils';
import { scriptedSpawnerLayer } from '@test/support/childProcessTestLayer';
import {
  fakeProcessServices,
  hostStores,
  installPlatform,
} from '@test/support/setupPlatform';
import { wolfram } from '@texra/tools/integrationPlugins';
import { texraPlugins } from '@texra/tools/registry';
import { seedDisabledToolDefaults } from '@tools/pluginCatalog';

describe('seedDisabledToolDefaults', () => {
  afterEach(() => installPlatform());

  // An empty list is the person's choice (every tool enabled); reseeding it
  // would silently switch their tools back off on the next start.
  it.effect(
    'does not seed for an already-seeded DISABLED_TOOLS list, even an empty one',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          installPlatform({
            globalState: { [GlobalStateKey.DISABLED_TOOLS]: [] as string[] },
          }),
        );

        yield* seedDisabledToolDefaults(
          hostStores().globalState,
          texraPlugins(),
        );

        expect(
          yield* hostStores().globalState.get(GlobalStateKey.DISABLED_TOOLS),
        ).toEqual([]);
      }),
  );
});

/**
 * A dashboard refresh forks the version probes; an interrupted refresh must
 * stop the `<tool> --version` process it spawned, not leave it running.
 */
describe('external tool availability probes', () => {
  it.effect('an interrupted version probe stops the process it spawned', () =>
    Effect.gen(function* () {
      const spawner = scriptedSpawnerLayer(() => 'hang');
      const fiber = yield* Effect.forkChild(
        wolfram
          .availability!.check()
          .pipe(
            Effect.provide(spawner.layer),
            Effect.provide(fakeProcessServices()),
          ),
      );

      yield* Effect.promise(() =>
        waitForCondition(() => spawner.calls.length > 0),
      );
      yield* Fiber.interrupt(fiber);

      expect(spawner.killed).toEqual(spawner.calls);
    }),
  );
});
