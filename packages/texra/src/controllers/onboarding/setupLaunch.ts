import { Effect } from 'effect';

import { Cancelled } from '@texra-ai/harness';
import {
  presentRunFailure,
  type Secrets,
  type SessionHostInteractions,
} from '@texra-ai/harness/host';
import { validateRunRequest } from '@texra/controllers/session/runRequests';
import type { HostRunActions } from '@texra/controllers/session/hostRunActions';
import { resolveSetupLaunchModel } from '@texra/model/setupCredentialAccess';
import { SETUP_AGENT_NAME } from '@texra/shared/constants/agents';
import type { SettingsStores } from '@texra-ai/harness/host';

/** Instruction handed to the setup agent when launched. Shared by every host. */
export const SETUP_INSTRUCTION =
  'Finish installing TeXRA. Probe my environment, install anything missing, and configure a working credential.';

/**
 * Launch the setup conversation from the desktop's setup card: resolve a
 * model the user's credentials can call, build the setup request, and run it
 * through the project's launch path, the one the Execute button uses. `run`
 * and `roots` are the project the user started setup in, taken before the
 * first suspension: the run and its presentation belong to it even when the
 * window moves to another project while the model resolves.
 * Setup continues after its initiating request has completed, so a failure
 * is presented here; the kickoff settles with the setup run, so a second Run
 * Setup waits for it, and the run's own failure is its result row's to show.
 */
export const kickoffDesktopSetup = (options: {
  readonly roots: SettingsStores;
  /** The project window's launch path, and where it presents a failure;
   *  none before the window has bound the project. */
  readonly run:
    | (Pick<HostRunActions, 'runValidated'> & {
        readonly present: Pick<SessionHostInteractions, 'emit'>;
      })
    | undefined;
}): Effect.Effect<void, never, Secrets> => {
  const { run } = options;
  if (!run)
    return Effect.logWarning(
      'Setup did not start: the window has not bound its project yet.',
    );
  return Effect.gen(function* () {
    const model = yield* resolveSetupLaunchModel(options.roots);
    if (model === null) {
      return yield* Effect.fail(
        new Error(
          'No model is available for your current credentials. Sign in with ChatGPT or add a provider or coding-plan API key in Models, then try setup again.',
        ),
      );
    }
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
    return yield* run.runValidated(validation.request);
  }).pipe(
    Effect.catch((error) =>
      error instanceof Cancelled
        ? Effect.void
        : presentRunFailure(run.present, error),
    ),
    Effect.flatMap((started) =>
      started === undefined
        ? Effect.void
        : started.result.pipe(
            Effect.asVoid,
            Effect.catch((failure) =>
              Effect.logDebug(`The setup run failed: ${failure.message}`),
            ),
          ),
    ),
  );
};
