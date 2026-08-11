/** Profile handlers: UPDATE_PROFILE. */

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';
import type {
  SpendingStatus,
  SpendingStatusError,
} from '@shared/schemas/spendingStatus';

import {
  apiAccessMode,
  authenticated,
  globalStreamingDefault,
  providerKeyStatuses,
  quotaAutoSwitched,
  sessionProblem,
  spendingStatus,
  spendingStatusError,
  tier,
  userEmail,
} from '../settingsState';

function spendingStatusEqual(
  a: SpendingStatus | null,
  b: SpendingStatus | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.currentSpend === b.currentSpend &&
    a.limit === b.limit &&
    a.remaining === b.remaining &&
    a.percentUsed === b.percentUsed
  );
}

function spendingStatusErrorEqual(
  a: SpendingStatusError | null,
  b: SpendingStatusError | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.spendCheckFailed === b.spendCheckFailed &&
    a.failureReason === b.failureReason &&
    a.limit === b.limit
  );
}

export const profileHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE]: (data) => {
    authenticated.set(data.authenticated);
    userEmail.set(data.user?.email ?? 'N/A');
    tier.set(data.tier);
    const newSpend = data.spendingStatus ?? null;
    // Skip the signal update when the snapshot is value-equal so the Lit
    // re-render isn't triggered on every UPDATE_PROFILE just because the
    // JSON parse produced a fresh object reference.
    if (!spendingStatusEqual(spendingStatus.get(), newSpend)) {
      spendingStatus.set(newSpend);
    }
    // Fields declared with `.prefault()` in UpdateProfileMessageSchema are
    // guaranteed present by the validating dispatcher — no fallback needed.
    sessionProblem.set(data.sessionProblem);
    const newSpendError = data.spendingStatusError ?? null;
    if (!spendingStatusErrorEqual(spendingStatusError.get(), newSpendError)) {
      spendingStatusError.set(newSpendError);
    }
    quotaAutoSwitched.set(data.quotaAutoSwitched);
    apiAccessMode.set(data.apiAccessMode);
    providerKeyStatuses.set(data.providerKeyStatuses);
    globalStreamingDefault.set(data.globalStreamingDefault);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
