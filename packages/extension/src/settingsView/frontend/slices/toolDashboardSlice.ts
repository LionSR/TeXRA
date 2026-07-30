/** Tool dashboard handlers: UPDATE_TOOL_DASHBOARD. */

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import { toolDashboardItems, toolDashboardLoaded } from '../settingsState';

export const toolDashboardHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD]: (data) => {
    toolDashboardItems.set(data.items);
    toolDashboardLoaded.set(true);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
