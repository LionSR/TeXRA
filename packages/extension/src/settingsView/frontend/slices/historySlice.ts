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

import { historyItems } from '../settingsState';

export const historyHandlers = {
  // Ordering is owned by the sole producer, `buildHistoryMessage`, over an
  // already newest-first `listExecutions()`; the view renders what it is given.
  [SETTINGS_VIEW_COMMANDS.UPDATE_HISTORY]: (data) => {
    historyItems.set(data.historyItems);
  },

  [SETTINGS_VIEW_COMMANDS.HISTORY_CLEARED]: () => {
    historyItems.set([]);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
