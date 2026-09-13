// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect } from 'vitest';

// Local imports
import { GlobalStateKey } from '@shared/state/stateKeys';
import { hostStores, installPlatform } from '@test/support/setupPlatform';
import { EXTERNAL_TOOL_DEFS } from '@tools/externalToolDefs';
import { seedDisabledToolDefaults } from '@tools/toolAvailability';

const EXPECTED_DEFAULTS = EXTERNAL_TOOL_DEFS.filter(
  (def) => def.toggleable,
).map((def) => def.id);

describe('seedDisabledToolDefaults', () => {
  afterEach(() => installPlatform());

  it.effect(
    'seeds toggleable tool defaults when DISABLED_TOOLS is missing',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => installPlatform());

        yield* seedDisabledToolDefaults(hostStores().globalState);

        expect(
          hostStores().globalState.get(GlobalStateKey.DISABLED_TOOLS),
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
          hostStores().globalState.get(GlobalStateKey.DISABLED_TOOLS),
        ).toEqual([]);
      }),
  );
});
