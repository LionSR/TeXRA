/** Agent teams handlers: UPDATE_AGENT_MODE_PRESETS. */

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import { customPresets, orchestratorAgents } from '../settingsState';

export const agentTeamsHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_MODE_PRESETS]: (data) => {
    customPresets.set(data.customPresets);
    orchestratorAgents.set(data.orchestratorAgents ?? []);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
