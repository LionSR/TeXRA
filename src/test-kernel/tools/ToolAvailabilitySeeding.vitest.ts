// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

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
  afterEach(async () => {
    await installPlatform();
  });

  it('seeds every toggleable tool as disabled on a genuinely fresh install', async () => {
    await installPlatform({ globalState: {} });

    await seedDisabledToolDefaults(VERSION_KEY);

    expect(platform().globalState.get(GlobalStateKey.DISABLED_TOOLS)).toEqual(
      EXPECTED_DEFAULTS,
    );
  });

  it.each([
    {
      name: 'a host with a prior-install version marker',
      globalState: { [VERSION_KEY]: '1.2.3' },
    },
    {
      name: 'an already-seeded DISABLED_TOOLS list, even an empty one',
      globalState: { [GlobalStateKey.DISABLED_TOOLS]: [] as string[] },
    },
  ])('does not seed for $name', async ({ globalState }) => {
    await installPlatform({ globalState });

    await seedDisabledToolDefaults(VERSION_KEY);

    expect(platform().globalState.get(GlobalStateKey.DISABLED_TOOLS)).toEqual(
      globalState[GlobalStateKey.DISABLED_TOOLS],
    );
  });
});
