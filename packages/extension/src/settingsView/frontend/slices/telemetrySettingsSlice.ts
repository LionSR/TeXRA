import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import { telemetryEnabled } from '../settingsState';

export const telemetrySettingsHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_TELEMETRY_SETTINGS]: (data) => {
    telemetryEnabled.set(data.enabled);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
