/**
 * Memory handlers: UPDATE_MEMORY, UPDATE_MEMORY_ENABLED, UPDATE_MEMORY_PREVIEW.
 */

import { create } from 'mutative';

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import {
  memoryEnabled,
  memoryItems,
  memoryToggleDisabled,
} from '../settingsState';

// `SettingsViewOutboundHandlerRegistry` is now exhaustive (every SettingsView
// outbound command needs a real handler or `unsupported(...)` — see
// `@shared/utils/dispatcher`). This slice only owns memory commands, so it's
// typed as a `satisfies Partial<...>` subset rather than the full registry;
// `messageDispatcher.ts` spreads all slices together and is the actual
// exhaustiveness checkpoint TypeScript enforces.
export const memoryHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY]: (data) => {
    memoryItems.set(data.items ?? []);
  },

  [SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_ENABLED]: (data) => {
    memoryEnabled.set(data.enabled);
    memoryToggleDisabled.set(false);
  },

  [SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_PREVIEW]: (data) => {
    const { storagePath, preview, lineCount, error } = data.preview;
    memoryItems.set(
      create(memoryItems.get(), (draft) => {
        const item = draft.find((entry) => entry.storagePath === storagePath);
        if (!item) return;
        if (error) {
          item.preview = undefined;
          item.lineCount = undefined;
          item.previewError = true;
        } else {
          item.preview = preview;
          if (lineCount !== undefined) item.lineCount = lineCount;
          item.previewError = undefined;
        }
      }),
    );
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
