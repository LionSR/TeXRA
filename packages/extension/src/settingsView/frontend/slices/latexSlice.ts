/**
 * LaTeX settings handlers: UPDATE_LATEX_SETTINGS_STATUS,
 * UPDATE_LATEX_CONFIG_VALUES, UPDATE_INLINE_CRITICISM_ENABLED.
 *
 * Feeds `<latex-tab>` (a stateless props-in/events-out leaf component — it
 * needs no changes for this migration).
 */

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type {
  LatexConfigValues,
  SettingsViewOutboundHandlerRegistry,
} from '@shared/schemas';
import { LATEX_CONFIG_FIELD_TO_KEY } from '@shared/constants/latexConfig';

import {
  inlineCriticismEnabled,
  latexConfigValues,
  latexConfigValuesLoaded,
  latexSettingsLoaded,
  latexSettingsStatus,
} from '../settingsState';

export const latexHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_SETTINGS_STATUS]: (data) => {
    latexSettingsStatus.set(data.settings);
    latexSettingsLoaded.set(true);
  },

  [SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_CONFIG_VALUES]: (data) => {
    latexConfigValues.set(
      Object.fromEntries(
        Object.entries(LATEX_CONFIG_FIELD_TO_KEY).map(([field, key]) => [
          field,
          data.values[key],
        ]),
      ) as LatexConfigValues,
    );
    latexConfigValuesLoaded.set(true);
  },

  [SETTINGS_VIEW_COMMANDS.UPDATE_INLINE_CRITICISM_ENABLED]: (data) => {
    inlineCriticismEnabled.set(data.enabled);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
