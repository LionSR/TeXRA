/** Tool dashboard handlers: UPDATE_TOOL_DASHBOARD. */

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import { toolDashboardItems, toolDashboardLoaded } from '../settingsState';

// `SettingsViewOutboundHandlerRegistry` is now exhaustive (every SettingsView
// outbound command needs a real handler or `unsupported(...)` — see
// `@shared/utils/dispatcher`). This slice only owns the tool-dashboard
// command, so it's typed as a `satisfies Partial<...>` subset rather than
// the full registry; `messageDispatcher.ts` spreads all slices together and
// is the actual exhaustiveness checkpoint TypeScript enforces.
export const toolDashboardHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD]: (data) => {
    toolDashboardItems.set(data.items);
    toolDashboardLoaded.set(true);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
