// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, describe, expect, vi } from 'vitest';

// Local imports
import { GlobalStateKey } from '@shared/state/stateKeys';
import { waitForCondition } from '@test/support/asyncTestUtils';
import { scriptedSpawnerLayer } from '@test/support/childProcessTestLayer';
import {
  fakeProcessServices,
  hostStores,
  installPlatform,
} from '@test/support/setupPlatform';
import { TOOL_PLUGINS, findToolPlugin } from '@tools/plugins';
import { seedDisabledToolDefaults } from '@tools/toolAvailability';

/** Let a forked probe reach the call it will be interrupted in. */
const started = Effect.promise(
  () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
);

const EXPECTED_DEFAULTS = TOOL_PLUGINS.filter(
  (plugin) => plugin.toggleable,
).map((plugin) => plugin.id);

describe('seedDisabledToolDefaults', () => {
  afterEach(() => installPlatform());

  it.effect(
    'seeds toggleable tool defaults when DISABLED_TOOLS is missing',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => installPlatform());

        yield* seedDisabledToolDefaults(hostStores().globalState);

        expect(
          yield* hostStores().globalState.get(GlobalStateKey.DISABLED_TOOLS),
        ).toEqual(EXPECTED_DEFAULTS);
      }),
  );

  it.effect(
    'does not seed for an already-seeded DISABLED_TOOLS list, even an empty one',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          installPlatform({
            globalState: { [GlobalStateKey.DISABLED_TOOLS]: [] as string[] },
          }),
        );

        yield* seedDisabledToolDefaults(hostStores().globalState);

        expect(
          yield* hostStores().globalState.get(GlobalStateKey.DISABLED_TOOLS),
        ).toEqual([]);
      }),
  );
});

/**
 * Both probe kinds a dashboard refresh forks have to answer to the fiber that
 * runs them: a spawned `<tool> --version` when the refresh is interrupted, and
 * the Zotero request when localhost never answers. The spawned probe lives in
 * the fiber's scope, and the Zotero request takes the fiber's own signal.
 */
describe('external tool availability probes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.effect('an interrupted version probe stops the process it spawned', () =>
    Effect.gen(function* () {
      const spawner = scriptedSpawnerLayer(() => 'hang');
      const texcount = findToolPlugin('texcount');
      const fiber = yield* Effect.forkChild(
        texcount!
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

  it.effect(
    'the Zotero probe answers at its deadline when nothing replies',
    () =>
      Effect.gen(function* () {
        vi.spyOn(globalThis, 'fetch').mockReturnValue(
          new Promise<Response>(() => {}),
        );
        const zotero = findToolPlugin('zotero');
        const fiber = yield* Effect.forkChild(
          // The port the group's own probe resolves out of the workspace
          // configuration, handed to `check` the way the availability layer
          // hands back a cached probe result.
          zotero!
            .availability!.check(23119)
            .pipe(Effect.provide(fakeProcessServices())),
        );

        yield* started;
        yield* TestClock.adjust('2000 millis');

        expect(yield* Fiber.join(fiber)).toBe(false);
      }),
  );
});
