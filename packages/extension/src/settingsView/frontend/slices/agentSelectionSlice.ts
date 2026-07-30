/** Agent selection handlers: UPDATE_AGENT_SELECTION, UPDATE_CUSTOM_AGENT_DIR. */

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import {
  customAgentDir,
  customAgentDirIsDefault,
  toolUseAgents,
  workflowAgents,
} from '../settingsState';

export const agentSelectionHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION]: (data) => {
    workflowAgents.set(data.workflow);
    toolUseAgents.set(data.toolUse);
  },

  [SETTINGS_VIEW_COMMANDS.UPDATE_CUSTOM_AGENT_DIR]: (data) => {
    customAgentDir.set(data.path);
    customAgentDirIsDefault.set(data.isDefault);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
