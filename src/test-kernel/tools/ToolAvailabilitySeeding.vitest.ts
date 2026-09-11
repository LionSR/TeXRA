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

const VERSION_KEY = 'test.lastKnownVersion';

const EXPECTED_DEFAULTS = EXTERNAL_TOOL_DEFS.filter(
  (def) => def.toggleable,
).map((def) => def.id);

describe('seedDisabledToolDefaults', () => {
  afterEach(() => installPlatform());

  it.effect.each([
    {
      name: 'a host with a prior-install version marker',
      globalState: { [VERSION_KEY]: '1.2.3' },
    },
    {
      name: 'an already-seeded DISABLED_TOOLS list, even an empty one',
      globalState: { [GlobalStateKey.DISABLED_TOOLS]: [] as string[] },
    },
  ])('does not seed for $name', ({ globalState }) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => installPlatform({ globalState }));

      yield* seedDisabledToolDefaults(platform().globalState, VERSION_KEY);

      expect(platform().globalState.get(GlobalStateKey.DISABLED_TOOLS)).toEqual(
        globalState[GlobalStateKey.DISABLED_TOOLS],
      );
    }),
  );
});
