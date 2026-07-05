/** Agent selection handlers: UPDATE_AGENT_SELECTION, UPDATE_CUSTOM_AGENT_DIR. */

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import {
  customAgentDir,
  customAgentDirIsDefault,
  toolUseAgents,
  workflowAgents,
} from '../settingsState';

// `SettingsViewOutboundHandlerRegistry` is now exhaustive (every SettingsView
// outbound command needs a real handler or `unsupported(...)` — see
// `@shared/utils/dispatcher`). This slice only owns agent-selection
// commands, so it's typed as a `satisfies Partial<...>` subset rather than
// the full registry; `messageDispatcher.ts` spreads all slices together and
// is the actual exhaustiveness checkpoint TypeScript enforces.
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
