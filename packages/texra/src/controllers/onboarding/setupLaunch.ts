import { Effect } from 'effect';

import { Cancelled } from '@texra-ai/harness';
import {
  type PlatformSecrets,
  presentRunFailure,
  type SessionHostInteractions,
} from '@texra-ai/harness/host';
import { hasLiveSetupRun } from '@texra/controllers/onboarding/onboardingFunnel';
import {
  validateRunRequest,
  type ValidatedRunRequest,
} from '@texra/controllers/session/runRequests';
import type { HostRunActions } from '@texra/controllers/session/hostRunActions';
import { resolveSetupLaunchModel } from '@texra/model/setupCredentialAccess';
import { SETUP_AGENT_NAME } from '@texra/shared/constants/agents';
import type { Run, Session } from '@texra-ai/harness';
import type { SettingsStores } from '@texra-ai/harness/host';

/** Instruction handed to the setup agent when launched. */
const SETUP_INSTRUCTION =
  'Finish installing TeXRA. Probe my environment, install anything missing, and configure a working credential.';

/**
 * Launch the setup conversation in `session` and wait for it to end. Every
 * host's setup entry point comes through here. `already-running` when the
 * session holds a live setup run, `no-model` when the user's credentials
 * can call no setup model (the missing-credential case; a check that cannot
 * be answered fails). A failure once the run started is its result row's to
 * show, not a failure to launch.
 */
export const launchSetup = <E>(options: {
  readonly session: Pick<Session, 'view'>;
  readonly roots: SettingsStores;
  readonly secrets: PlatformSecrets;
  /** This host's launch path for the setup request. */
  readonly start: (request: ValidatedRunRequest) => Effect.Effect<Run, E>;
}) =>
  Effect.gen(function* () {
    if (hasLiveSetupRun(options.session.view.current())) {
      return 'already-running' as const;
    }
    // The launch model the credential predicate every host shares decides:
    // adapter-level checks, so a blank env key does not count and fail later
    // as "No model is available".
    const model = yield* resolveSetupLaunchModel(
      options.roots,
      options.secrets,
    );
    if (model === null) return 'no-model' as const;
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
    const run = yield* options.start(validation.request);
    yield* run.result.pipe(
      Effect.asVoid,
      Effect.catch((failure) =>
        Effect.logDebug(`The setup run failed: ${failure.message}`),
      ),
    );
    return 'launched' as const;
  });

/**
 * Launch the setup conversation from the desktop's setup card through the
 * project's launch path, the one the Execute button uses. `run` and
 * `project` are the project the user started setup in, taken before the
 * first suspension: the run and its presentation belong to it even when the
 * window moves to another project while the model resolves.
 * Setup continues after its initiating request has completed, so a failure
 * is presented here; the kickoff finishes with the setup run, so a second
 * Run Setup waits for it. A setup run already live in the project is left
 * to run alone.
 */
export const kickoffDesktopSetup = (options: {
  readonly project: {
    readonly session: Pick<Session, 'view'>;
    readonly roots: SettingsStores;
    readonly present: Pick<SessionHostInteractions, 'emit'>;
  };
  /** The project's launch path; none when no folder is open. */
  readonly run: Pick<HostRunActions, 'runValidated'> | undefined;
  readonly secrets: PlatformSecrets;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!options.run) {
      return yield* Effect.fail(
        new Error('Open a folder before running setup.'),
      );
    }
    const outcome = yield* launchSetup({
      session: options.project.session,
      roots: options.project.roots,
      secrets: options.secrets,
      start: options.run.runValidated,
    });
    if (outcome === 'no-model') {
      return yield* Effect.fail(
        new Error(
          'No model is available for your current credentials. Sign in with ChatGPT or add a provider or coding-plan API key in Models, then try setup again.',
        ),
      );
    }
  }).pipe(
    Effect.catch((error) =>
      error instanceof Cancelled
        ? Effect.void
        : presentRunFailure(options.project.present, error),
    ),
  );
