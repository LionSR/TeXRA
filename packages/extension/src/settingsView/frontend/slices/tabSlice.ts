/** Tab handlers: SET_TAB. */

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import { agentSubTab, selectedTabIndex } from '../settingsState';

export const tabHandlers: SettingsViewOutboundHandlerRegistry = {
  [SETTINGS_VIEW_COMMANDS.SET_TAB]: (data) => {
    selectedTabIndex.set(data.tabIndex);
    agentSubTab.set(data.agentSubTab);
  },
};
