// Credential checks used by the interactive first-run onboarding gate.
//
// The default check remains mode-independent for launchers that have not pinned
// an API mode. When a command explicitly asks for included relay or personal
// keys, use the credential source that can actually satisfy that mode so a
// provider key does not suppress included-relay sign-in setup, and vice versa.

import { isCodexSubscriptionActive } from '@model/providerCapabilities';
import { hasAnyUsableProviderApiKey } from '@model/setupCredentialAccess';
import { CHATGPT_SETUP_MODEL } from '@model/setupModelDefaults';
import { platform } from '@platform/platform';
import { AgentCategory } from '@shared/schemas/agent';

import { getCliAuthProfile } from './supabaseAuth';
import type { CliApiMode } from './apiAccessMode';

async function hasIncludedRelaySignIn(): Promise<boolean> {
  const profile = await getCliAuthProfile().catch(() => undefined);
  return profile?.authenticated ?? false;
}

export async function hasCliCredentialForApiMode(
  apiMode: CliApiMode | undefined,
): Promise<boolean> {
  const hasChatGptSubscription = await isCodexSubscriptionActive(
    CHATGPT_SETUP_MODEL,
    AgentCategory.ToolUse,
  ).catch(() => false);
  if (hasChatGptSubscription) return true;

  switch (apiMode) {
    case 'included':
      return hasIncludedRelaySignIn();
    case 'personal':
      return hasAnyUsableProviderApiKey(platform().secrets);
    default:
      return (
        (await hasIncludedRelaySignIn()) ||
        (await hasAnyUsableProviderApiKey(platform().secrets))
      );
  }
}
