/** Approval-and-safety settings handler. */

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import { applySettingsSnapshot } from '../settingsState';

export const approvalSettingsHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_APPROVAL_SETTINGS]: (data) => {
    applySettingsSnapshot(data.values);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
