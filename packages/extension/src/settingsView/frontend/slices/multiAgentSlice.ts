/** Multi-agent coordination handlers: UPDATE_SUPER_YOLO_ENABLED. */

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import {
  allowOrchestratorKill,
  detachSubagentsOnStop,
  reliabilitySettings,
} from '../settingsState';

export const multiAgentHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_SUPER_YOLO_ENABLED]: (data) => {
    reliabilitySettings.set(data.reliabilitySettings);
    allowOrchestratorKill.set(data.allowOrchestratorKill);
    detachSubagentsOnStop.set(data.detachSubagentsOnStop);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
