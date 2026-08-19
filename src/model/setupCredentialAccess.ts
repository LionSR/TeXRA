import { API_PROVIDERS, lookupApiKey } from '@model/apiProviders';
import {
  isCodexSubscriptionActive,
  isXaiSubscriptionActive,
} from '@model/providerCapabilities';
import {
  CHATGPT_SETUP_MODEL,
  XAI_SETUP_MODEL,
} from '@model/setupModelDefaults';
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
 * Whether the setup model can run through ChatGPT, Grok, or a provider key.
 *
 * Desktop and extension use this complete policy. The CLI composes the same
 * probes itself (`hasCliRunCredential`) so it can wrap each one with
 * per-probe error logging.
 */
export async function hasUsableSetupCredential(
  secrets: PlatformSecrets,
): Promise<boolean> {
  if (await isCodexSubscriptionActive(CHATGPT_SETUP_MODEL)) {
    return true;
  }
  if (await isXaiSubscriptionActive(XAI_SETUP_MODEL)) {
    return true;
  }
  return hasAnyUsableProviderApiKey(secrets);
}
