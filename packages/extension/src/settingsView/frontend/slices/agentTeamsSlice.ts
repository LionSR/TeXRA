/** Agent teams handlers: UPDATE_AGENT_MODE_PRESETS. */

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import { customPresets, orchestratorAgents } from '../settingsState';

// `SettingsViewOutboundHandlerRegistry` is now exhaustive (every SettingsView
// outbound command needs a real handler or `unsupported(...)` — see
// `@shared/utils/dispatcher`). This slice only owns the agent-teams command,
// so it's typed as a `satisfies Partial<...>` subset rather than the full
// registry; `messageDispatcher.ts` spreads all slices together and is the
// actual exhaustiveness checkpoint TypeScript enforces.
export const agentTeamsHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_MODE_PRESETS]: (data) => {
    customPresets.set(data.customPresets);
    orchestratorAgents.set(data.orchestratorAgents ?? []);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
