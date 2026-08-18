/** Profile handlers: UPDATE_PROFILE. */

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import {
  authenticated,
  globalStreamingDefault,
  providerKeyStatuses,
  sessionProblem,
  userEmail,
} from '../settingsState';

export const profileHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE]: (data) => {
    authenticated.set(data.authenticated);
    userEmail.set(data.user?.email ?? 'N/A');
    // Fields declared with `.prefault()` in UpdateProfileMessageSchema are
    // guaranteed present by the validating dispatcher — no fallback needed.
    sessionProblem.set(data.sessionProblem);
    providerKeyStatuses.set(data.providerKeyStatuses);
    globalStreamingDefault.set(data.globalStreamingDefault);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
