/**
 * Profile message construction shared between the VS Code extension and the
 * Electron desktop settings controllers.
 *
 * Builds the `UPDATE_PROFILE` wire message from shared auth / agent services
 * so the two hosts can't drift. The one host-specific input — provider key
 * statuses, which carry VS Code settings on the extension and none on desktop
 * — is injected as a callback.
 *
 * Profile-metadata reads degrade gracefully: a transient failure keeps the user
 * signed in with fallback values rather than failing the whole refresh (the
 * resilience the desktop assembly already had).
 */
import { SupabaseClient } from '@auth/SupabaseClient';
import { PROFILE_VIEW_COMMANDS } from '@shared/ipc';
import type { ProviderKeyStatus, UpdateProfileMessage } from '@shared/schemas';
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
  const authenticated = storedSessionState === 'authenticated';
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
      sessionProblem,
    };
  }

  const user = await SupabaseClient.getUser();

  return {
    ...base,
    authenticated: true,
    user: {
      email: user?.email ?? storedEmail ?? 'N/A',
    },
    sessionProblem,
  };
}
