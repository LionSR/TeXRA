// Side-effect appliers for the onboarding key path. Kept out of the .tsx
// renderer so the persistence path can be tested without mounting Ink, and so
// the renderer stays props-in -> JSX-out.

import { platform } from '@platform/platform';
import {
  apiKeySecretName,
  invalidateApiKeyCache,
  type ApiProvider,
} from '@model/apiProviders';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';

import { setCliApiMode } from '../runtime/apiAccessMode';

import { describeSavedKeyLocation } from './onboardingState';

/**
 * Persist a provider API key entered during onboarding and make it the active
 * credential path: write the secret, drop the key + model-options caches so the
 * very next availability read sees it (no process restart), and switch to
 * personal API-key mode. Returns the "where we stored it" line — never the key.
 */
export async function saveProviderApiKey(
  provider: ApiProvider,
  key: string,
): Promise<string> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error('API key is empty.');

  await platform().secrets.set(apiKeySecretName(provider), trimmed);
  // computeModelOptions reads `requiresKey` through the apiProviders cache; both
  // caches must drop or the launcher/chat would re-read a stale "no key" result
  // for up to the 5s TTL and still show the "login required" wall.
  invalidateApiKeyCache();
  invalidateModelOptionsCache();
  // setCliApiMode persists the mode and itself invalidates model options.
  await setCliApiMode('personal');

  return describeSavedKeyLocation(provider);
}
