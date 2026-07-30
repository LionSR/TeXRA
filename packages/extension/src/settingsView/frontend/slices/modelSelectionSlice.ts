/** Model selection handlers: UPDATE_MODEL_SELECTION. */

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import {
  helperModel,
  modelSelectionItems,
  preferShortModelNames,
} from '../settingsState';

export const modelSelectionHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION]: (data) => {
    modelSelectionItems.set(data.models);
    helperModel.set(data.helperModel);
    preferShortModelNames.set(data.preferShortModelNames);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
