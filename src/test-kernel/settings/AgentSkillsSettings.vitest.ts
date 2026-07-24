// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { ConfigInspection, ConfigTarget } from '@platform/interfaces';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  AGENT_SKILLS_CONFIG_TARGET,
  buildAgentSkillsSettingsMessage,
  setAgentSkillsEnabled,
} from '@shared/settingsView/handlers/agentSkillsHandlers';
import { AGENT_SKILLS_CONFIG_KEY } from '@shared/schemas/agentSkills';

class RecordingConfigProvider {
  value = true;
  readonly updateCalls: Array<{
    key: string;
    value: unknown;
    target: ConfigTarget | undefined;
  }> = [];

  get<T>(_key: string, defaultValue?: T): T {
    return (this.value ?? defaultValue) as T;
  }

  async update<T>(key: string, value: T, target?: ConfigTarget): Promise<void> {
    this.updateCalls.push({ key, value, target });
  }

  inspect<T = unknown>(_key: string): ConfigInspection<T> | undefined {
    return undefined;
  }

  isExplicitlySet(): boolean {
    return false;
  }

  watch(): { dispose(): void } {
    return { dispose: () => undefined };
  }
}

describe('agent skills settings', () => {
  it('builds the shared extension and desktop settings message', () => {
    const config = new RecordingConfigProvider();

    expect(buildAgentSkillsSettingsMessage(config)).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SKILLS_SETTINGS,
      enabled: true,
    });
  });

  it('persists the switch in workspace configuration', async () => {
    const config = new RecordingConfigProvider();

    await setAgentSkillsEnabled(config, false);

    expect(config.updateCalls).toEqual([
      {
        key: AGENT_SKILLS_CONFIG_KEY,
        value: false,
        target: AGENT_SKILLS_CONFIG_TARGET,
      },
    ]);
  });
});
