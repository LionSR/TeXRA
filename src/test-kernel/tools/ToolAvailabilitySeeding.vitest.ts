// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect } from 'vitest';

// Local imports
import { platform } from '@platform/platform';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { installPlatform } from '@test/support/setupPlatform';
import { EXTERNAL_TOOL_DEFS } from '@tools/externalToolDefs';
import { seedDisabledToolDefaults } from '@tools/toolAvailability';

describe('seedDisabledToolDefaults', () => {
  afterEach(() => installPlatform());

  it.effect('seeds toggleable tool defaults when DISABLED_TOOLS is missing', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => installPlatform());

      yield* seedDisabledToolDefaults(platform().globalState);

      expect(platform().globalState.get(GlobalStateKey.DISABLED_TOOLS)).toEqual(
        EXTERNAL_TOOL_DEFS.filter((def) => def.toggleable).map((def) => def.id),
      );
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

        yield* seedDisabledToolDefaults(platform().globalState);

        expect(
          platform().globalState.get(GlobalStateKey.DISABLED_TOOLS),
        ).toEqual([]);
      }),
  );
});
