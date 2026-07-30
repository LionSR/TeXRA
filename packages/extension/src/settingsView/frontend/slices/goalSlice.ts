/** Goal handlers: UPDATE_GOAL_LIST. */

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import { goalItems } from '../settingsState';

export const goalHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_GOAL_LIST]: (data) => {
    goalItems.set(data.items);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
