// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { MemoryStateStore } from '@platform/defaults/memoryState';
import {
  AGENT_SKILLS_CONFIG_KEY,
  settingsViewSettingByKey,
} from '@shared/schemas';
import { writeSetting } from '@shared/config/settingsAccess';
import { FakeConfigProvider } from '@test/support/FakePlatform';

describe('agent skills settings', () => {
  it('persists the switch in workspace configuration', async () => {
    const config = new FakeConfigProvider();
    const entry = settingsViewSettingByKey(AGENT_SKILLS_CONFIG_KEY);
    expect(entry).toBeDefined();

    await writeSetting(entry!, false, {
      config,
      workspaceState: new MemoryStateStore(),
      globalState: new MemoryStateStore(),
    });

    expect(config.get(AGENT_SKILLS_CONFIG_KEY)).toBe(false);
    expect(config.inspect(AGENT_SKILLS_CONFIG_KEY)).toMatchObject({
      workspaceValue: false,
    });
  });
});
