/** Goal handlers: UPDATE_GOAL_LIST. */

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import { goalItems } from '../settingsState';

// `SettingsViewOutboundHandlerRegistry` is now exhaustive (every SettingsView
// outbound command needs a real handler or `unsupported(...)` — see
// `@shared/utils/dispatcher`). This slice only owns the goal command, so
// it's typed as a `satisfies Partial<...>` subset rather than the full
// registry; `messageDispatcher.ts` spreads all slices together and is the
// actual exhaustiveness checkpoint TypeScript enforces.
export const goalHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_GOAL_LIST]: (data) => {
    goalItems.set(data.items);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
