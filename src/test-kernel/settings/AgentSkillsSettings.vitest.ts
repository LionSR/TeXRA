// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { MemoryStateStore } from '@platform/defaults/memoryState';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { writeSetting } from '@shared/config/settingsAccess';
import {
  AGENT_SKILLS_CONFIG_KEY,
  AGENT_SKILLS_ENABLED_DEFAULT,
} from '@shared/schemas/agentSkills';
import {
  buildAgentSkillsSettingsMessage,
  readAgentSkillsEnabled,
} from '@shared/settingsView/handlers/agentSkillsHandlers';
import { settingsViewSettingByKey } from '@shared/schemas/stateSettings';
import { FakeConfigProvider } from '@test/support/FakePlatform';

describe('agent skills settings', () => {
  it('builds the shared extension and desktop settings message', () => {
    const config = new FakeConfigProvider({
      [AGENT_SKILLS_CONFIG_KEY]: true,
    });

    expect(buildAgentSkillsSettingsMessage(config)).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SKILLS_SETTINGS,
      enabled: true,
    });
  });

  it('uses the documented default when no setting is present', () => {
    const config = new FakeConfigProvider();

    expect(buildAgentSkillsSettingsMessage(config).enabled).toBe(
      AGENT_SKILLS_ENABLED_DEFAULT,
    );
  });

  it('rejects malformed present values at the configuration boundary', () => {
    const config = new FakeConfigProvider({
      [AGENT_SKILLS_CONFIG_KEY]: 'false',
    });

    expect(() => readAgentSkillsEnabled(config)).toThrow();
  });

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
