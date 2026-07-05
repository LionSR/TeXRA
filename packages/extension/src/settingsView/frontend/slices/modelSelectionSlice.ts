/** Model selection handlers: UPDATE_MODEL_SELECTION. */

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import {
  helperModel,
  modelSelectionItems,
  preferShortModelNames,
} from '../settingsState';

// `SettingsViewOutboundHandlerRegistry` is now exhaustive (every SettingsView
// outbound command needs a real handler or `unsupported(...)` — see
// `@shared/utils/dispatcher`). This slice only owns the model-selection
// command, so it's typed as a `satisfies Partial<...>` subset rather than
// the full registry; `messageDispatcher.ts` spreads all slices together and
// is the actual exhaustiveness checkpoint TypeScript enforces.
export const modelSelectionHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION]: (data) => {
    modelSelectionItems.set(data.models);
    helperModel.set(data.helperModel);
    preferShortModelNames.set(data.preferShortModelNames);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
