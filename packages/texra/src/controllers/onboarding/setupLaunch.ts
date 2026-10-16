import { Effect } from 'effect';

import {
  Cancelled,
  type PlatformSecrets,
  type LanguageModel,
} from '@texra-ai/harness';
import type { SessionHostInteractions } from '@agent/runtime/HostInteractions';
import { presentRunFailure } from '@agent/runtime/terminalResultToast';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { validateRunRequest } from '@texra/controllers/session/runRequests';
import type { HostRunActions } from '@texra/controllers/session/hostRunActions';
import { resolveSetupLaunchModel } from '@texra/model/setupCredentialAccess';
import type { SettingsStores } from '@texra-ai/harness';

/** Instruction handed to the setup agent when launched. Shared by every host. */
export const SETUP_INSTRUCTION =
  'Finish installing TeXRA. Probe my environment, install anything missing, and configure a working credential.';

/**
 * Launch the setup conversation from the desktop's setup card: resolve a
 * model the user's credentials can call, build the setup request, and run it
 * through the project's launch path, the one the Execute button uses. `run`
 * and `project` are the project the user started setup in, taken before the
 * first suspension: the run and its presentation belong to it even when the
 * window moves to another project while the model resolves. Desktop has no
 * routing prompt, so OpenRouter is chosen only when the flag is already on
 * and an OpenRouter key exists (the access-list fallback is opted out).
 * Setup continues after its initiating request has completed, so a failure
 * is presented here; the kickoff settles with the setup run, so a second Run
 * Setup waits for it, and the run's own failure is its result row's to show.
 */
export const kickoffDesktopSetup = (options: {
  readonly project: {
    readonly roots: SettingsStores;
    readonly present: Pick<SessionHostInteractions, 'emit'>;
  };
  /** The project's launch path; none when no folder is open. */
  readonly run: Pick<HostRunActions, 'runValidated'> | undefined;
  readonly secrets: PlatformSecrets;
}): Effect.Effect<void, never, LanguageModel> =>
  Effect.gen(function* () {
    if (!options.run) {
      return yield* Effect.fail(
        new Error('Open a folder before running setup.'),
      );
    }
    const resolved = yield* resolveSetupLaunchModel(
      options.project.roots,
      options.secrets,
      false,
    );
    if (!resolved) {
      return yield* Effect.fail(
        new Error(
          'No model is available for your current credentials. Sign in with ChatGPT or add a provider or coding-plan API key in Models, then try setup again.',
        ),
      );
    }
    const validation = validateRunRequest({
      config: {
        agent: SETUP_AGENT_NAME,
        model: resolved.model,
        instruction: SETUP_INSTRUCTION,
      },
    });
    if (!validation.valid) {
      return yield* Effect.fail(new Error(validation.message));
    }
    return yield* options.run.runValidated(validation.request);
  }).pipe(
    Effect.catch((error) =>
      error instanceof Cancelled
        ? Effect.void
        : presentRunFailure(options.project.present, error),
    ),
    Effect.flatMap((run) =>
      run === undefined
        ? Effect.void
        : run.result.pipe(
            Effect.asVoid,
            Effect.catch((failure) =>
              Effect.logDebug(`The setup run failed: ${failure.message}`),
            ),
          ),
    ),
  );
