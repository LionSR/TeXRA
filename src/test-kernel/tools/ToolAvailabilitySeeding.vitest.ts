// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports
import { platform } from '@platform/platform';
import { DELEGATE_MULTI_AGENTS_TOOL_NAME } from '@shared/constants/delegationTools';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { installPlatform } from '@test/support/setupPlatform';
import { EXTERNAL_TOOL_DEFS } from '@tools/externalToolDefs';
import {
  getDisabledToolNames,
  seedDisabledToolDefaults,
} from '@tools/toolAvailability';
import { getDisabledToolIds, setToolEnabled } from '@utils/config/constants';

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

  it('does not seed for a host with a prior-install version marker', async () => {
    await installPlatform({
      globalState: { [VERSION_KEY]: '1.2.3' },
    });

    await seedDisabledToolDefaults(VERSION_KEY);

    expect(
      platform().globalState.get(GlobalStateKey.DISABLED_TOOLS),
    ).toBeUndefined();
  });

  it('never overwrites an already-seeded DISABLED_TOOLS list, even an empty one', async () => {
    await installPlatform({
      globalState: { [GlobalStateKey.DISABLED_TOOLS]: [] },
    });

    await seedDisabledToolDefaults(VERSION_KEY);

    expect(platform().globalState.get(GlobalStateKey.DISABLED_TOOLS)).toEqual(
      [],
    );
  });
});

describe('renamed tool group IDs', () => {
  afterEach(async () => {
    await installPlatform();
  });

  it('keeps a group disabled when its persisted ID was renamed', async () => {
    await installPlatform({
      globalState: { [GlobalStateKey.DISABLED_TOOLS]: ['workflow-script'] },
    });

    expect(getDisabledToolIds().has('multi-agent-workflow')).toBe(true);
    expect(getDisabledToolNames().has(DELEGATE_MULTI_AGENTS_TOOL_NAME)).toBe(
      true,
    );
  });

  it('rewrites the persisted list to the current ID on the next toggle', async () => {
    await installPlatform({
      globalState: {
        [GlobalStateKey.DISABLED_TOOLS]: ['workflow-script', 'lean4'],
      },
    });

    await setToolEnabled('lean4', true);

    expect(platform().globalState.get(GlobalStateKey.DISABLED_TOOLS)).toEqual([
      'multi-agent-workflow',
    ]);
  });
});
