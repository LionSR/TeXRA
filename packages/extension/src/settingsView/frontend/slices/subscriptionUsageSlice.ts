import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import { subscriptionUsage } from '../settingsState';

export const subscriptionUsageHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_USAGE]: (data) => {
    subscriptionUsage.set(data.snapshots);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
