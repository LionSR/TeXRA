// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { MemoryStateStore } from '@platform/defaults/memoryState';
import {
  BASH_APPROVAL_CONFIG_KEY,
  settingsViewSettingByKey,
} from '@shared/schemas';
import { writeSetting } from '@shared/config/settingsAccess';
import { FakeConfigProvider } from '@test/support/FakePlatform';

describe('bash-approval settings', () => {
  it('persists the current setting in workspace configuration', async () => {
    const config = new FakeConfigProvider();
    const entry = settingsViewSettingByKey(BASH_APPROVAL_CONFIG_KEY);
    expect(entry).toBeDefined();

    await writeSetting(entry!, false, {
      config,
      workspaceState: new MemoryStateStore(),
      globalState: new MemoryStateStore(),
    });

    expect(config.get(BASH_APPROVAL_CONFIG_KEY)).toBe(false);
    expect(config.inspect(BASH_APPROVAL_CONFIG_KEY)).toMatchObject({
      workspaceValue: false,
    });
  });
});
