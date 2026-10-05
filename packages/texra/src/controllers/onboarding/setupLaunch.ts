import { Effect } from 'effect';

import {
  validateRunRequest,
  type ValidatedRunRequest,
} from '@agent/core/state/runRequests';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { resolveSetupLaunchModel } from '@texra/model/setupCredentialAccess';
import type { PlatformSecrets } from '@texra-ai/harness';
import type { LanguageModel } from '@texra-ai/harness';

/** Instruction handed to the setup agent when launched. Shared by every host. */
export const SETUP_INSTRUCTION =
  'Finish installing TeXRA. Probe my environment, install anything missing, and configure a working credential.';

/**
 * Build the validated run request that launches the setup conversation, or
 * `null` when no credential resolves to a runnable model.
 *
 * Desktop has no routing prompt, so OpenRouter is chosen only when the flag is
 * already on and an OpenRouter key exists: the access-list fallback is opted
 * out and the resolution is projected to its model.
 */
export function buildDesktopSetupRunRequest(
  stores: SettingsStores,
  secrets: PlatformSecrets,
): Effect.Effect<ValidatedRunRequest | null, Error, LanguageModel> {
  return Effect.gen(function* () {
    const model =
      (yield* resolveSetupLaunchModel(stores, secrets, false))?.model ?? null;
    if (!model) return null;
    const validation = validateRunRequest({
      config: {
        agent: SETUP_AGENT_NAME,
        model,
        instruction: SETUP_INSTRUCTION,
      },
    });
    if (!validation.valid) {
      return yield* Effect.fail(new Error(validation.message));
    }
    return validation.request;
  });
}
