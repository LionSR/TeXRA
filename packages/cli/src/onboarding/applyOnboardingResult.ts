// Side-effect appliers for the onboarding key path. Kept out of the .tsx
// renderer so the persistence path can be tested without mounting Ink, and so
// the renderer stays props-in -> JSX-out.

import { platform } from '@platform/platform';
import {
  apiKeySecretName,
  invalidateApiKeyCache,
  type ApiProvider,
} from '@model/apiProviders';

import { setCliApiMode } from '../runtime/apiAccessMode';

import { describeSavedKeyLocation } from './onboardingState';

/**
 * Persist a provider API key entered during onboarding and make it the active
 * credential path: write the secret, drop the key cache so the very next
 * availability read sees it (no process restart), and switch to personal
 * API-key mode. Returns the "where we stored it" line — never the key.
 */
export async function saveProviderApiKey(
  provider: ApiProvider,
  key: string,
): Promise<string> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error('API key is empty.');

  // Write the secret BEFORE invalidating, so a concurrent read can't repopulate
  // a stale "no key" entry. invalidateApiKeyCache drops the provider-key cache
  // that computeModelOptions reads `requiresKey` from; setCliApiMode persists
  // personal mode AND invalidates the model-options cache, so a single
  // availability read afterward reflects the new key.
  await platform().secrets.set(apiKeySecretName(provider), trimmed);
  invalidateApiKeyCache();
  await setCliApiMode('personal');

  return describeSavedKeyLocation(provider);
}
