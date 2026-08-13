import type { ConfigProvider } from '@platform/interfaces';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  AGENT_SKILLS_CONFIG_KEY,
  AGENT_SKILLS_ENABLED_DEFAULT,
  AgentSkillsEnabledSchema,
} from '@shared/schemas/agentSkills';
import type { UpdateAgentSkillsSettingsMessage } from '@shared/schemas/settingsViewMessages';

export function readAgentSkillsEnabled(config: ConfigProvider): boolean {
  return AgentSkillsEnabledSchema.parse(
    config.get<unknown>(AGENT_SKILLS_CONFIG_KEY, AGENT_SKILLS_ENABLED_DEFAULT),
  );
}

export function buildAgentSkillsSettingsMessage(
  config: ConfigProvider,
): UpdateAgentSkillsSettingsMessage {
  return {
    command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SKILLS_SETTINGS,
    enabled: readAgentSkillsEnabled(config),
  };
}
