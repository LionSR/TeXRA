/**
 * View-wide handlers: SET_TAB and SET_UNSUPPORTED_COMMANDS. Neither belongs to
 * a single domain slice — both are chrome-level concerns (active tab, and the
 * derived capability view gating controls across tabs) rather than a section
 * of `SettingsApp`'s per-domain state.
 */

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import {
  agentSubTab,
  selectedPanel,
  unsupportedCommands,
} from '../settingsState';

export const tabHandlers = {
  [SETTINGS_VIEW_COMMANDS.SET_TAB]: (data) => {
    selectedPanel.set(data.tab);
    agentSubTab.set(data.agentSubTab);
  },
  [SETTINGS_VIEW_COMMANDS.SET_UNSUPPORTED_COMMANDS]: (data) => {
    unsupportedCommands.set(new Set(data.commands));
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
