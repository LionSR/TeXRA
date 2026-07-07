/** Multi-agent coordination handlers: UPDATE_SUPER_YOLO_ENABLED. */

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import {
  allowOrchestratorKill,
  detachSubagentsOnStop,
  reliabilitySettings,
} from '../settingsState';

// `SettingsViewOutboundHandlerRegistry` is now exhaustive (every SettingsView
// outbound command needs a real handler or `unsupported(...)` — see
// `@shared/utils/dispatcher`). This slice only owns the multi-agent command,
// so it's typed as a `satisfies Partial<...>` subset rather than the full
// registry; `messageDispatcher.ts` spreads all slices together and is the
// actual exhaustiveness checkpoint TypeScript enforces.
export const multiAgentHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_SUPER_YOLO_ENABLED]: (data) => {
    reliabilitySettings.set(data.reliabilitySettings);
    allowOrchestratorKill.set(data.allowOrchestratorKill);
    detachSubagentsOnStop.set(data.detachSubagentsOnStop);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
