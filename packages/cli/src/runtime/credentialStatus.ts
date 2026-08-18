// Credential checks used by the interactive first-run onboarding gate.

import { warn as logWarning } from '@logger/logUtils';
import {
  isCodexSubscriptionActive,
  isXaiSubscriptionActive,
} from '@model/providerCapabilities';
import { hasAnyUsableProviderApiKey } from '@model/setupCredentialAccess';
import {
  CHATGPT_SETUP_MODEL,
  XAI_SETUP_MODEL,
} from '@model/setupModelDefaults';
import { platform } from '@platform/platform';
import { toErrorMessage } from '@utils/errors/errorMessage';

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

function hasProviderApiKey(): Promise<boolean> {
  return probeCredential('Provider API key', () =>
    hasAnyUsableProviderApiKey(platform().secrets),
  );
}

/** Never rejects: every probe resolves to false with a logged reason. */
export async function hasCliRunCredential(): Promise<boolean> {
  const hasChatGptSubscription = await probeCredential(
    'ChatGPT subscription',
    () => isCodexSubscriptionActive(CHATGPT_SETUP_MODEL),
  );
  if (hasChatGptSubscription) return true;
  const hasGrokSubscription = await probeCredential('Grok subscription', () =>
    isXaiSubscriptionActive(XAI_SETUP_MODEL),
  );
  if (hasGrokSubscription) return true;
  return hasProviderApiKey();
}
