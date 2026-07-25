import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import { agentSkillsEnabled } from '../settingsState';

export const agentSkillsSettingsHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SKILLS_SETTINGS]: (data) => {
    agentSkillsEnabled.set(data.enabled);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
