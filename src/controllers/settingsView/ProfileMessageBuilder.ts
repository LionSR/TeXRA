/**
 * Profile message construction shared between the VS Code extension and the
 * Electron desktop settings controllers.
 *
 * Builds the `UPDATE_PROFILE` wire message from shared auth / tier / agent
 * services so the two hosts can't drift — previously each host hand-assembled
 * the message and desktop silently dropped `spendingStatus` + `quotaAutoSwitched`
 * (killing the RelayQuotaMeter / quota-auto-switch banner on desktop). The one
 * host-specific input — provider key statuses, which carry VS Code settings on
 * the extension and none on desktop — is injected as a callback.
 *
 * Profile-metadata reads degrade gracefully: a transient failure keeps the user
 * signed in with fallback values rather than failing the whole refresh (the
 * resilience the desktop assembly already had).
 */
import { SupabaseClient } from '@auth/SupabaseClient';
import { FREE_TIER } from '@auth/config';
import { getServerSideKeyService } from '@auth/serverKeys';
import { PROFILE_VIEW_COMMANDS } from '@shared/ipc';
import type {
  ApiAccessMode,
  ProviderKeyStatus,
  UpdateProfileMessage,
} from '@shared/schemas';
import { getGlobalStreaming } from '@utils/config/providerConfig';

interface BuildProfileMessageDeps {
  /**
   * Build the provider key statuses. Host-specific: the extension fills
   * `providerSettings` supplied by the active host.
   */
  getProviderKeyStatuses: () => Promise<ProviderKeyStatus[]>;
}

/** Assemble the canonical `UPDATE_PROFILE` message for either host. */
export async function buildProfileMessage(
  deps: BuildProfileMessageDeps,
): Promise<UpdateProfileMessage> {
  const [storedSessionState, providerKeyStatuses] = await Promise.all([
    SupabaseClient.getStoredSessionState(),
    deps.getProviderKeyStatuses(),
  ]);
  const authenticated =
    storedSessionState === 'authenticated' ||
    SupabaseClient.hasUsableRelayToken();
  const base = {
    command: PROFILE_VIEW_COMMANDS.UPDATE_PROFILE,
    providerKeyStatuses,
    globalStreamingDefault: getGlobalStreaming(),
  };

  // Preserve the distinction between an authoritatively rejected refresh
  // credential and a transient transport/service failure. Both have a stored
  // account but require different user guidance.
  const hasStoredSession = storedSessionState !== 'none';
  let sessionProblem: UpdateProfileMessage['sessionProblem'] = null;
  if (storedSessionState === 'invalid') {
    sessionProblem = 'expired';
  } else if (storedSessionState === 'transient') {
    sessionProblem = 'unavailable';
  }
  const storedEmail = hasStoredSession
    ? await SupabaseClient.getStoredAccountLabel()
    : null;

  if (!authenticated) {
    return {
      ...base,
      authenticated: false,
      user: storedEmail ? { email: storedEmail } : null,
      tier: FREE_TIER,
      apiAccessMode: 'personal',
      sessionProblem,
      spendingStatus: null,
      spendingStatusError: null,
      quotaAutoSwitched: false,
    };
  }

  const user = await SupabaseClient.getUser();

  let tier = FREE_TIER;
  try {
    tier = await SupabaseClient.getUserTier();
  } catch {
    // Keep the UI signed in even if profile metadata is temporarily unavailable.
  }

  let apiAccessMode: ApiAccessMode = 'personal';
  let spendingStatus: UpdateProfileMessage['spendingStatus'] = null;
  let spendingStatusError: UpdateProfileMessage['spendingStatusError'] = null;
  let quotaAutoSwitched = false;
  try {
    const serverSideKeyService = getServerSideKeyService();
    // Prime included-access ONLY when it is actually enabled. canUseServerSideKeys()
    // refreshes (and can clear) the tier cache including the spending snapshot, so
    // priming in personal mode would blank the relay quota UI on every refresh.
    // (This mirrors the extension's prior primeIncludedAccessIfEnabled gating.)
    if (serverSideKeyService.getUseIncludedModelAccess()) {
      await serverSideKeyService.canUseServerSideKeys();
    }
    // Usage belongs to the account, not to the active routing mode.
    await serverSideKeyService.refreshSpendingStatus();
    // Read AFTER priming, so a quota-exhaustion auto-switch (included -> personal,
    // flipped inside canUseServerSideKeys) is reflected in apiAccessMode /
    // quotaAutoSwitched rather than reporting the pre-switch mode.
    apiAccessMode = serverSideKeyService.getUseIncludedModelAccess()
      ? 'included'
      : 'personal';
    quotaAutoSwitched = serverSideKeyService.wasQuotaAutoSwitched();
    spendingStatus = serverSideKeyService.getSpendingStatus();
    spendingStatusError = serverSideKeyService.getSpendingStatusError();
  } catch {
    // Server-side key / tier access is optional; personal provider keys work.
  }

  return {
    ...base,
    authenticated: true,
    user: {
      email: user?.email ?? storedEmail ?? 'N/A',
    },
    tier,
    apiAccessMode,
    sessionProblem,
    spendingStatus,
    spendingStatusError,
    quotaAutoSwitched,
  };
}
