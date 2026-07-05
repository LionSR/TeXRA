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
  selectedTabIndex,
  unsupportedCommands,
} from '../settingsState';

// `SettingsViewOutboundHandlerRegistry` is now exhaustive (every SettingsView
// outbound command needs a real handler or `unsupported(...)` — see
// `@shared/utils/dispatcher`). This slice only owns the two view-wide
// commands above, so it's typed as a `satisfies Partial<...>` subset rather
// than the full registry; `messageDispatcher.ts` spreads all slices together
// and is the actual exhaustiveness checkpoint TypeScript enforces.
export const tabHandlers = {
  [SETTINGS_VIEW_COMMANDS.SET_TAB]: (data) => {
    selectedTabIndex.set(data.tabIndex);
    agentSubTab.set(data.agentSubTab);
  },
  [SETTINGS_VIEW_COMMANDS.SET_UNSUPPORTED_COMMANDS]: (data) => {
    unsupportedCommands.set(new Set(data.commands));
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
