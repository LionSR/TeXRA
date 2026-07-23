// Third-party imports
import { describe, expect, it } from 'vitest';

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
  it('seeds every toggleable tool as disabled on a genuinely fresh install', async () => {
    await installPlatform({ globalState: {} });
    try {
      await seedDisabledToolDefaults(VERSION_KEY);

      expect(platform().globalState.get(GlobalStateKey.DISABLED_TOOLS)).toEqual(
        EXPECTED_DEFAULTS,
      );
    } finally {
      await installPlatform();
    }
  });

  it('does not seed for a host with a prior-install version marker', async () => {
    await installPlatform({
      globalState: { [VERSION_KEY]: '1.2.3' },
    });
    try {
      await seedDisabledToolDefaults(VERSION_KEY);

      expect(
        platform().globalState.get(GlobalStateKey.DISABLED_TOOLS),
      ).toBeUndefined();
    } finally {
      await installPlatform();
    }
  });

  it('never overwrites an already-seeded DISABLED_TOOLS list, even an empty one', async () => {
    await installPlatform({
      globalState: { [GlobalStateKey.DISABLED_TOOLS]: [] },
    });
    try {
      await seedDisabledToolDefaults(VERSION_KEY);

      expect(platform().globalState.get(GlobalStateKey.DISABLED_TOOLS)).toEqual(
        [],
      );
    } finally {
      await installPlatform();
    }
  });
});
