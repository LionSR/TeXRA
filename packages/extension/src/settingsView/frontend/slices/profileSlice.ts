/** Profile handlers: UPDATE_PROFILE. */

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';
import type { SpendingStatus } from '@shared/schemas/spendingStatus';

import {
  apiAccessMode,
  authenticated,
  globalStreamingDefault,
  providerKeyStatuses,
  quotaAutoSwitched,
  sessionExpired,
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

// `SettingsViewOutboundHandlerRegistry` is now exhaustive (every SettingsView
// outbound command needs a real handler or `unsupported(...)` — see
// `@shared/utils/dispatcher`). This slice only owns the profile command, so
// it's typed as a `satisfies Partial<...>` subset rather than the full
// registry; `messageDispatcher.ts` spreads all slices together and is the
// actual exhaustiveness checkpoint TypeScript enforces.
export const profileHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE]: (data) => {
    authenticated.set(data.authenticated);
    userEmail.set(data.user?.email ?? 'N/A');
    tier.set(data.tier ?? 'free');
    const newSpend = data.spendingStatus ?? null;
    // Skip the signal update when the snapshot is value-equal so the Lit
    // re-render isn't triggered on every UPDATE_PROFILE just because the
    // JSON parse produced a fresh object reference.
    if (!spendingStatusEqual(spendingStatus.get(), newSpend)) {
      spendingStatus.set(newSpend);
    }
    sessionExpired.set(data.sessionExpired ?? false);
    spendingStatusError.set(data.spendingStatusError ?? null);
    quotaAutoSwitched.set(data.quotaAutoSwitched ?? false);
    apiAccessMode.set(data.apiAccessMode);
    providerKeyStatuses.set(data.providerKeyStatuses ?? []);
    globalStreamingDefault.set(data.globalStreamingDefault ?? true);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
