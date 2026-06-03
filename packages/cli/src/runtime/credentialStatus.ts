// Credential checks used by the interactive first-run onboarding gate.
//
// The default check remains mode-independent for launchers that have not pinned
// an API mode. When a command explicitly asks for included relay or personal
// keys, use the credential source that can actually satisfy that mode so a
// provider key does not suppress included-relay sign-in setup, and vice versa.

import { platform } from '@platform/platform';
import { API_PROVIDERS, apiKeyExists } from '@model/apiProviders';

import { getCliAuthProvider } from './supabaseAuth';
import type { CliApiMode } from './apiAccessMode';

async function hasIncludedRelaySignIn(): Promise<boolean> {
  return await getCliAuthProvider()
    .isAuthenticated()
    .catch(() => false);
}

async function hasProviderApiKey(): Promise<boolean> {
  const secrets = platform().secrets;
  for (const provider of API_PROVIDERS) {
    // Sequential by design: stop at the first key found.
    if (await apiKeyExists(secrets, provider)) return true;
  }
  return false;
}

export async function hasCliCredentialForApiMode(
  apiMode: CliApiMode | undefined,
): Promise<boolean> {
  switch (apiMode) {
    case 'included':
      return hasIncludedRelaySignIn();
    case 'personal':
      return hasProviderApiKey();
    default:
      return (await hasIncludedRelaySignIn()) || (await hasProviderApiKey());
  }
}
