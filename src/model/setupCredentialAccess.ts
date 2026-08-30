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
import { toErrorMessage } from '@utils/errors/errorMessage';

/** True when any provider has a usable API key in secret storage or the environment. */
async function hasAnyUsableProviderApiKey(
  secrets: PlatformSecrets,
): Promise<boolean> {
  for (const provider of API_PROVIDERS) {
    // Keep the scan sequential so the first usable key ends the lookup.
    if (isNonEmptyString(await lookupApiKey(secrets, provider))) return true;
  }
  return false;
}

/**
 * A probe failure is treated as no credential of that kind. The caller owns
 * reporting so this model-layer policy stays free of logging side effects.
 */
export async function probeSetupCredential(
  kind: string,
  check: () => Promise<boolean>,
  onProbeFailure: (message: string) => void,
): Promise<boolean> {
  return check().catch((error: unknown) => {
    onProbeFailure(
      `${kind} check failed; treating it as no credential: ${toErrorMessage(error)}`,
    );
    return false;
  });
}

/** Each failed credential probe resolves to false after being reported. */
export async function hasUsableSetupCredential(
  secrets: PlatformSecrets,
  onProbeFailure: (message: string) => void,
): Promise<boolean> {
  const hasChatGptSubscription = await probeSetupCredential(
    'ChatGPT subscription',
    () => isCodexSubscriptionActive(CHATGPT_SETUP_MODEL),
    onProbeFailure,
  );
  if (hasChatGptSubscription) return true;
  const hasGrokSubscription = await probeSetupCredential(
    'Grok subscription',
    () => isXaiSubscriptionActive(XAI_SETUP_MODEL),
    onProbeFailure,
  );
  if (hasGrokSubscription) return true;
  return probeSetupCredential(
    'Provider API key',
    () => hasAnyUsableProviderApiKey(secrets),
    onProbeFailure,
  );
}
