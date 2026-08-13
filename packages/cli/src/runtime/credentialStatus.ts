// Credential checks used by the interactive first-run onboarding gate.
//
// The default check remains mode-independent for launchers that have not pinned
// an API mode. When a command explicitly asks for included relay or personal
// keys, use the credential source that can actually satisfy that mode so a
// provider key does not suppress included-relay sign-in setup, and vice versa.

import { warn as logWarning } from '@logger/logUtils';
import { isCodexSubscriptionActive } from '@model/providerCapabilities';
import { hasAnyUsableProviderApiKey } from '@model/setupCredentialAccess';
import { CHATGPT_SETUP_MODEL } from '@model/setupModelDefaults';
import { platform } from '@platform/platform';
import type { ApiAccessMode } from '@shared/schemas/settingsViewMessages';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { getCliAuthProfile } from './supabaseAuth';

const LOG_CHANNEL = 'CLI Credentials';

/**
 * A probe that cannot answer means "no credential of this kind", which is the
 * safe answer for a gate whose failure mode is showing setup again. It is never
 * a silent one: the reason is logged so a broken keychain or an offline auth
 * check is diagnosable instead of looking like a missing credential.
 */
async function probeCredential(
  kind: string,
  check: () => Promise<boolean>,
): Promise<boolean> {
  return check().catch((error: unknown) => {
    logWarning(
      LOG_CHANNEL,
      `${kind} check failed; treating it as no credential: ${toErrorMessage(error)}`,
    );
    return false;
  });
}

function hasIncludedRelaySignIn(): Promise<boolean> {
  return probeCredential('Included access sign-in', async () => {
    const profile = await getCliAuthProfile();
    return profile.authenticated;
  });
}

function hasProviderApiKey(): Promise<boolean> {
  return probeCredential('Provider API key', () =>
    hasAnyUsableProviderApiKey(platform().secrets),
  );
}

/** Never rejects: every probe resolves to false with a logged reason. */
export async function hasCliCredentialForApiMode(
  apiMode: ApiAccessMode | undefined,
): Promise<boolean> {
  const hasChatGptSubscription = await probeCredential(
    'ChatGPT subscription',
    () => isCodexSubscriptionActive(CHATGPT_SETUP_MODEL),
  );
  if (hasChatGptSubscription) return true;

  switch (apiMode) {
    case 'included':
      return hasIncludedRelaySignIn();
    case 'personal':
      return hasProviderApiKey();
    default:
      return (await hasIncludedRelaySignIn()) || (await hasProviderApiKey());
  }
}
