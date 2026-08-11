import { API_PROVIDERS, lookupApiKey } from '@model/apiProviders';
import { includedModelAccess } from '@model/includedModelAccess';
import { isCodexSubscriptionActive } from '@model/providerCapabilities';
import { CHATGPT_SETUP_MODEL } from '@model/setupModelDefaults';
import type { PlatformSecrets } from '@platform/secrets';
import { isNonEmptyString } from '@utils/core';

/** True when any provider has a usable API key in secret storage or the environment. */
export async function hasAnyUsableProviderApiKey(
  secrets: PlatformSecrets,
): Promise<boolean> {
  for (const provider of API_PROVIDERS) {
    // Keep the scan sequential so the first usable key ends the lookup.
    if (isNonEmptyString(await lookupApiKey(secrets, provider))) return true;
  }
  return false;
}

/**
 * Whether the setup model can run through ChatGPT, a provider key, or included
 * TeXRA access. Local credentials deliberately precede the server check: that
 * check is a network request and may update relay-quota routing state.
 *
 * Desktop and extension use this complete policy. The CLI composes
 * {@link hasAnyUsableProviderApiKey} separately because its selected model
 * access mode determines whether a provider key or included sign-in applies.
 */
export async function hasUsableSetupCredential(
  secrets: PlatformSecrets,
): Promise<boolean> {
  if (await isCodexSubscriptionActive(CHATGPT_SETUP_MODEL)) {
    return true;
  }
  if (await hasAnyUsableProviderApiKey(secrets)) return true;
  return includedModelAccess().canUseServerSideKeys();
}
