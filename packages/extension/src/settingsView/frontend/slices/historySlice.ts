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

// `SettingsViewOutboundHandlerRegistry` is now exhaustive (every SettingsView
// outbound command needs a real handler or `unsupported(...)` — see
// `@shared/utils/dispatcher`). This slice only owns history commands, so
// it's typed as a `satisfies Partial<...>` subset rather than the full
// registry; `messageDispatcher.ts` spreads all slices together and is the
// actual exhaustiveness checkpoint TypeScript enforces.
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
