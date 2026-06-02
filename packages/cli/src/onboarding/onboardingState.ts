// Pure, host-neutral onboarding helpers. No Ink, no `platform()` calls — so the
// gate's decision logic and the "where we saved it" messaging stay unit-testable
// without mounting the TUI or booting the platform (the repo's
// "stateless renderers" rule, applied to onboarding).

import {
  apiKeyEnvName,
  apiKeySecretName,
  type ApiProvider,
} from '@model/apiProviders';

import type { StateStore } from '@platform/interfaces/state';

/**
 * Global (user-level) flag: the user saw the first-run picker and chose
 * "Skip for now". Persisted so a deliberate keyless user is not re-prompted on
 * every credential-less launch — `texra setup` / `texra login` are the way back
 * in. Stored in ~/.texra/state.json via `platform().globalState`, alongside
 * ServerSideKeyService's `texra.useIncludedModelAccess`.
 */
export const ONBOARDING_DECLINED_KEY = 'texra.cli.onboardingDeclined';

export function getOnboardingDeclined(state: StateStore): boolean {
  return state.get<boolean>(ONBOARDING_DECLINED_KEY, false) === true;
}

export async function setOnboardingDeclined(
  state: StateStore,
  declined: boolean,
): Promise<void> {
  await state.update(ONBOARDING_DECLINED_KEY, declined);
}

/**
 * Human-facing "we stored your key here" line. Naming the exact secret entry
 * (and the env-var alternative) fixes the opacity other CLIs have about where a
 * pasted key actually went. Never includes the key itself.
 */
export function describeSavedKeyLocation(provider: ApiProvider): string {
  return `Stored in TeXRA secrets as \`${apiKeySecretName(provider)}\` (or set ${apiKeyEnvName(provider)} in your environment).`;
}
