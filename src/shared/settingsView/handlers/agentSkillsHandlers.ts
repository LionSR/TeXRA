import type { ConfigProvider, ConfigTarget } from '@platform/interfaces';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  AGENT_SKILLS_CONFIG_KEY,
  AGENT_SKILLS_ENABLED_DEFAULT,
  AgentSkillsEnabledSchema,
} from '@shared/schemas/agentSkills';
import type { UpdateAgentSkillsSettingsMessage } from '@shared/schemas/settingsViewMessages';

export const AGENT_SKILLS_CONFIG_TARGET: ConfigTarget = 'workspace';

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

export async function setAgentSkillsEnabled(
  config: ConfigProvider,
  enabled: boolean,
): Promise<void> {
  await config.update(
    AGENT_SKILLS_CONFIG_KEY,
    enabled,
    AGENT_SKILLS_CONFIG_TARGET,
  );
}
