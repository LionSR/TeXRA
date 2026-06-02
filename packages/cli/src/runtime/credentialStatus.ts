// "Does the user have any usable credential path?" — the single signal the
// first-run onboarding gate keys off.
//
// Deliberately mode-independent: the orchestrate launcher boots the platform
// with included-access probing skipped (initLocalCliPlatform forces personal
// mode), so an api-mode-derived model list (getCliModelAccessList) is
// unreliable there and would mis-flag a signed-in returning user as
// credential-less. Checking the two real credential sources directly — a stored
// TeXRA sign-in (included relay) and any resolvable provider key (secret OR
// env) — is correct in both entry points.

import { platform } from '@platform/platform';
import { API_PROVIDERS, apiKeyExists } from '@model/apiProviders';

import { getCliAuthProvider } from './supabaseAuth';

export async function hasAnyCliCredential(): Promise<boolean> {
  const signedIn = await getCliAuthProvider()
    .isAuthenticated()
    .catch(() => false);
  if (signedIn) return true;

  const secrets = platform().secrets;
  const present = await Promise.all(
    API_PROVIDERS.map((provider) => apiKeyExists(secrets, provider)),
  );
  return present.some(Boolean);
}
