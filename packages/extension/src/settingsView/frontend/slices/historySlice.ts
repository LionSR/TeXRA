/**
 * History handlers: UPDATE_HISTORY, HISTORY_CLEARED.
 *
 * `HISTORY_CLEARED` also needs to clear the `<history-tab>` search box, which
 * is a DOM ref owned by `SettingsApp` (`@query('history-tab')`) rather than
 * signal state — `SettingsApp` layers that side effect on top of this
 * handler's `historyItems` reset (see its `messageHandlers` composition).
 */

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';
import { toNewestFirstByTimestamp } from '@utils/core';

import { historyItems } from '../settingsState';

export const historyHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_HISTORY]: (data) => {
    historyItems.set(
      toNewestFirstByTimestamp(data.historyItems, (item) => item.timestamp),
    );
  },

  [SETTINGS_VIEW_COMMANDS.HISTORY_CLEARED]: () => {
    historyItems.set([]);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
