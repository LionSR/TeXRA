import { warn as logWarning } from '@logger/logUtils';
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

const LOG_CHANNEL = 'Setup Credentials';

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
 * A probe failure is treated as no credential of that kind and logged so
 * broken secret storage or an offline subscription check remains diagnosable.
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

/** Never rejects: every probe resolves to false with a logged reason. */
export async function hasUsableSetupCredential(
  secrets: PlatformSecrets,
): Promise<boolean> {
  const hasChatGptSubscription = await probeCredential(
    'ChatGPT subscription',
    () => isCodexSubscriptionActive(CHATGPT_SETUP_MODEL),
  );
  if (hasChatGptSubscription) return true;
  const hasGrokSubscription = await probeCredential('Grok subscription', () =>
    isXaiSubscriptionActive(XAI_SETUP_MODEL),
  );
  if (hasGrokSubscription) return true;
  return probeCredential('Provider API key', () =>
    hasAnyUsableProviderApiKey(secrets),
  );
}
