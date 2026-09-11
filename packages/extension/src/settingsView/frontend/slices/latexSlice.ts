/**
 * LaTeX settings handlers: UPDATE_LATEX_SETTINGS_STATUS,
 * UPDATE_INLINE_CRITICISM_ENABLED. The LaTeX config values arrive through
 * UPDATE_SETTINGS_SNAPSHOT (miscSettingsSlice.ts).
 *
 * Feeds `<latex-tab>` (a stateless props-in/events-out leaf component — it
 * needs no changes for this migration).
 */

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import {
  inlineCriticismEnabled,
  latexSettingsLoaded,
  latexSettingsStatus,
} from '../settingsState';

export const latexHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_SETTINGS_STATUS]: (data) => {
    latexSettingsStatus.set(data.settings);
    latexSettingsLoaded.set(true);
  },

  [SETTINGS_VIEW_COMMANDS.UPDATE_INLINE_CRITICISM_ENABLED]: (data) => {
    inlineCriticismEnabled.set(data.enabled);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
