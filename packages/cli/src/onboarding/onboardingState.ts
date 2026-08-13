// CLI-specific onboarding messaging. The funnel flags (declined,
// firstRunDone, default team) live host-neutrally in
// `@shared/state/onboardingState` so the extension and desktop
// derive the same funnel from the same keys.

import {
  apiKeyEnvName,
  apiKeySecretName,
  type ApiProvider,
} from '@model/apiProviders';
import { providerDisplayName } from '@shared/constants/providers';
import type { CliModelAccessSelectionResult } from '../runtime/modelAccessSelection';

/**
 * Human-facing "we stored your key here" line. Naming the exact secret entry
 * (and the env-var alternative) fixes the opacity other CLIs have about where a
 * pasted key actually went. Never includes the key itself.
 */
export function describeSavedKeyLocation(provider: ApiProvider): string {
  return `Stored in TeXRA secrets as \`${apiKeySecretName(provider)}\` (or set ${apiKeyEnvName(provider)} in your environment).`;
}

export function formatSavedKeySummary(
  provider: ApiProvider,
  selection: CliModelAccessSelectionResult,
): string {
  return `Saved your ${providerDisplayName(
    provider,
  )} API key. ${describeSavedKeyLocation(provider)} ${selection.message}`;
}
