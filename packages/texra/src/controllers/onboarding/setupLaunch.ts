import type { ProcessServices } from '@texra-ai/harness/host';
import { Effect, Schema } from 'effect';

import {
  agentName,
  type AgentConfig,
  Cancelled,
} from '@texra-ai/harness/schemas';
import { presentRunFailure, type Notices } from '@texra-ai/harness/host';
import { decodeLaunchConfig } from '@texra/controllers/session/launchConfig';
import type { HostRunActions } from '@texra/controllers/session/hostRunActions';
import { resolveSetupLaunchModel } from '@texra/model/setupCredentialAccess';
import { SETUP_AGENT_NAME } from '@texra/shared/constants/agents';
import type { Run, Session } from '@texra-ai/harness';
import type { Secrets, SettingsStores } from '@texra-ai/harness/plugins';

/** Instruction handed to the setup agent when launched. */
const SETUP_INSTRUCTION =
  'Finish installing TeXRA. Probe my environment, install anything missing, and configure a working credential.';

/** The session already holds a live setup run. */
class SetupAlreadyRunning extends Schema.TaggedError<SetupAlreadyRunning>()(
  'SetupAlreadyRunning',
  { message: Schema.String },
) {}

/** The user's credentials can call no setup model. */
class NoSetupModel extends Schema.TaggedError<NoSetupModel>()('NoSetupModel', {
  message: Schema.String,
}) {}

/**
 * Launch the setup conversation in `session` and wait for it to end. Every
 * host's setup entry point comes through here. It fails with
 * {@link SetupAlreadyRunning} or {@link NoSetupModel}, and with an `Error`
 * when the credential check cannot be answered. A refusal of the launch path
 * is that path's to show, and a run that fails ends with its result row:
 * neither is a failure here. A run whose end cannot be read is logged at
 * warn.
 */
export const launchSetup = Effect.fn('launchSetup')(function* <E, R>(options: {
  readonly session: Pick<Session, 'view'>;
  readonly roots: SettingsStores;
  /** This host's launch path for the setup request, which logs and shows a
   *  failure to start (`HostRunActions.runValidated`). */
  readonly start: (config: AgentConfig) => Effect.Effect<Run, E, R>;
}): Effect.fn.Return<
  void,
  SetupAlreadyRunning | NoSetupModel | Error,
  R | Effect.Services<ReturnType<typeof resolveSetupLaunchModel>>
> {
  // A second setup conversation, however it was started, would race the
  // first one's installs and config writes.
  const live = [...options.session.view.current().runs.values()].some(
    (run) =>
      run.holder === 'here' &&
      run.identity.kind === 'agent' &&
      agentName(run.identity.agent) === SETUP_AGENT_NAME,
  );
  if (live)
    return yield* new SetupAlreadyRunning({
      message: 'The setup assistant is already running.',
    });
  // The launch model the credential predicate every host shares decides:
  // adapter-level checks, so a blank env key does not count and fail later
  // as "No model is available".
  const model = yield* resolveSetupLaunchModel(options.roots);
  if (model === null)
    return yield* new NoSetupModel({
      message:
        'No model is available for your current credentials. Sign in with ChatGPT or add a provider or coding-plan API key in Models, then try setup again.',
    });
  // An Error, as every host words a failed setup launch by its message.
  const config = yield* decodeLaunchConfig({
    agent: SETUP_AGENT_NAME,
    model,
    instruction: SETUP_INSTRUCTION,
  }).pipe(Effect.mapError(({ reason }) => new Error(reason)));
  yield* options.start(config).pipe(
    Effect.flatMap((run) =>
      run.result.pipe(
        Effect.asVoid,
        // The result fails only when the run stored no end that can be
        // read: no result row shows that, and the view reads the run as
        // interrupted without saying why, so the cause is logged here.
        Effect.catch((failure) =>
          Effect.logWarning(
            `The setup run's end could not be read: ${failure.message}`,
          ),
        ),
      ),
    ),
    // The launch path has shown its refusal already.
    Effect.catch(() => Effect.void),
  );
});

/** A project window's launch path for its setup conversation: the project's
 *  session and settings, its launcher (`HostRunActions.runValidated`), and
 *  where a failure before a run opens is presented. The window's shared
 *  body holds all four and hands them to the host's setup verb. */
export interface WindowSetupLaunch {
  readonly session: Pick<Session, 'view'>;
  readonly roots: SettingsStores;
  readonly runValidated: HostRunActions['runValidated'];
  readonly present: Notices;
}

/**
 * Launch the setup conversation from the desktop's setup card through the
 * launch path of the window that asked, the one its Execute button uses.
 * Setup continues after its initiating request has completed, so a failure
 * before the launch is presented here (the launch path presents its own);
 * the kickoff finishes with the setup run, so a second Run Setup waits for
 * it. A setup run already live in the project is left to run alone.
 */
export const kickoffDesktopSetup = (
  launch: WindowSetupLaunch,
): Effect.Effect<void, never, Secrets | ProcessServices> =>
  launchSetup({
    session: launch.session,
    roots: launch.roots,
    start: launch.runValidated,
  }).pipe(
    Effect.catchTag('SetupAlreadyRunning', () => Effect.void),
    Effect.catch((error) =>
      error instanceof Cancelled
        ? Effect.void
        : presentRunFailure(launch.present, error),
    ),
  );
