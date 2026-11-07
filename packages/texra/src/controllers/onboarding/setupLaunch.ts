import type { ProcessServices } from '@texra-ai/harness/host';
import { Effect, Schema } from 'effect';

import { Cancelled } from '@texra-ai/harness';
import { agentName, type AgentConfig } from '@texra-ai/harness/schemas';
import {
  presentRunFailure,
  type Secrets,
  type Notices,
} from '@texra-ai/harness/host';
import { decodeLaunchConfig } from '@texra/controllers/session/launchConfig';
import type { HostRunActions } from '@texra/controllers/session/hostRunActions';
import { resolveSetupLaunchModel } from '@texra/model/setupCredentialAccess';
import { SETUP_AGENT_NAME } from '@texra/shared/constants/agents';
import type { Run, Session } from '@texra-ai/harness';
import type { SettingsStores } from '@texra-ai/harness/host';

/** Instruction handed to the setup agent when launched. */
const SETUP_INSTRUCTION =
  'Finish installing TeXRA. Probe my environment, install anything missing, and configure a working credential.';

/** The session already holds a live setup run. */
class SetupAlreadyRunning extends Schema.TaggedError<SetupAlreadyRunning>()(
  'SetupAlreadyRunning',
  { message: Schema.String },
) {}

/** The user's credentials can call no setup model. */
class NoSetupModel extends Schema.TaggedError<NoSetupModel>()(
  'NoSetupModel',
  { message: Schema.String },
) {}

/**
 * Launch the setup conversation in `session` and wait for it to end. Every
 * host's setup entry point comes through here. It fails with
 * {@link SetupAlreadyRunning} or {@link NoSetupModel}, and with an `Error`
 * when the credential check cannot be answered. A refusal of the launch path
 * is that path's to show, and a failure once the run started is its result
 * row's: neither is a failure here.
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
        Effect.catch((failure) =>
          Effect.logDebug(`The setup run failed: ${failure.message}`),
        ),
      ),
    ),
    // The launch path has shown its refusal already.
    Effect.catch(() => Effect.void),
  );
});

/**
 * Launch the setup conversation from the desktop's setup card through the
 * project's launch path, the one the Execute button uses. `run` and
 * `project` are the project the user started setup in, taken before the
 * first suspension: the run and its presentation belong to it even when the
 * window moves to another project while the model resolves.
 * Setup continues after its initiating request has completed, so a failure
 * before the launch is presented here (the launch path presents its own);
 * the kickoff finishes with the setup run, so a second Run Setup waits for
 * it. A setup run already live in the project is left to run alone.
 */
export const kickoffDesktopSetup = (options: {
  readonly project: {
    readonly session: Pick<Session, 'view'>;
    readonly roots: SettingsStores;
  };
  /** The project window's launch path, and where it presents a failure;
   *  none before the window has bound the project. */
  readonly run:
    | (Pick<HostRunActions, 'runValidated'> & {
        readonly present: Notices;
      })
    | undefined;
}): Effect.Effect<void, never, Secrets | ProcessServices> => {
  const { run } = options;
  if (!run)
    return Effect.logWarning(
      'Setup did not start: the window has not bound its project yet.',
    );
  return launchSetup({
    session: options.project.session,
    roots: options.project.roots,
    start: run.runValidated,
  }).pipe(
    Effect.catchTag('SetupAlreadyRunning', () => Effect.void),
    Effect.catch((error) =>
      error instanceof Cancelled
        ? Effect.void
        : presentRunFailure(run.present, error),
    ),
  );
};
