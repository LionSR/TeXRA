import { Effect, Semaphore } from 'effect';

import {
  agentName,
  Cancelled,
  type AgentConfig,
  type RunId,
} from '@texra-ai/harness/schemas';
import { presentRunFailure, type Notices } from '@texra-ai/harness/host';
import { withLogChannel } from '@texra-ai/harness/plugins';
import { decodeLaunchConfig } from '@texra/controllers/session/launchConfig';
import { resolveSetupLaunchModel } from '@texra/model/setupCredentialAccess';
import { SETUP_AGENT_NAME } from '@texra/shared/constants/agents';
import type { Dialogs } from '@texra/hosts/uiHosts';
import type { Run, Session } from '@texra-ai/harness';
import type { SettingsStores } from '@texra-ai/harness/plugins';

/** The setup assistant's log channel, for its launch and what follows it. */
const CHANNEL = 'SetupAssistant';

/** Instruction handed to the setup agent when launched. */
const SETUP_INSTRUCTION =
  'Finish installing TeXRA. Probe my environment, install anything missing, and configure a working credential.';

/** What a project window lends its setup verb: the project's session and
 *  settings, its launcher (`HostRunActions.runValidated`), its notices, and
 *  the two places a launch that cannot start sends the user. */
interface WindowSetupPorts<E, R> {
  readonly session: Pick<Session, 'view'>;
  readonly roots: SettingsStores;
  /** The window's launcher, which logs and shows a failure to start. */
  readonly start: (config: AgentConfig) => Effect.Effect<Run, E, R>;
  /** Where a failure before a run opens is presented. */
  readonly present: Notices;
  readonly notify: Dialogs['notify'];
  /** Bring `runId` into the window's run view. */
  showRun(runId: RunId): Effect.Effect<void, Error>;
  /** Bring the "Connect a model" card into view. */
  readonly showConnectModel: Effect.Effect<void, Error>;
}

/**
 * The setup verb of one project window, which every setup entry point of
 * that window calls (its setup card, VS Code's command and status pill). It
 * answers once the setup run has started or the user has been sent where the
 * launch could not go: a live setup run is shown, a missing model brings the
 * "Connect a model" card into view, and any other failure before the run
 * opens is presented once. A rejected launch is the launcher's to show.
 *
 * One launch at a time: a second call while the first still resolves its
 * model, before its run shows in the session view, is a no-op. After that
 * the live run answers it. The wait for the run's end belongs to the window
 * and stops with it; the run does not.
 */
export const openWindowSetup = Effect.fn('openWindowSetup')(function* <E, R>(
  ports: WindowSetupPorts<E, R>,
) {
  const starting = yield* Semaphore.make(1);
  const scope = yield* Effect.scope;
  const launch = Effect.gen(function* () {
    // A second setup conversation, however it was started, would race the
    // first one's installs and config writes.
    const live = [...ports.session.view.current().runs.values()].find(
      (run) =>
        run.holder === 'here' &&
        run.identity.kind === 'agent' &&
        agentName(run.identity.agent) === SETUP_AGENT_NAME,
    );
    if (live !== undefined) {
      yield* ports.notify('info', 'The setup assistant is already running.');
      return yield* ports.showRun(live.id);
    }
    // The launch model the credential predicate every host shares decides:
    // adapter-level checks, so a blank env key does not count and fail later
    // as "No model is available".
    const model = yield* resolveSetupLaunchModel(ports.roots);
    if (model === null) return yield* ports.showConnectModel;
    const config = yield* decodeLaunchConfig({
      agent: SETUP_AGENT_NAME,
      model,
      instruction: SETUP_INSTRUCTION,
    }).pipe(Effect.mapError(({ reason }) => new Error(reason)));
    const run = yield* ports.start(config).pipe(
      // The launcher has shown its rejection already.
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (run === undefined) return;
    // The result fails only when the run stored no end that can be read: no
    // result row shows that, and the view reads the run as interrupted
    // without saying why, so the cause is logged here.
    yield* Effect.forkIn(
      run.result.pipe(
        Effect.asVoid,
        Effect.catch((failure) =>
          Effect.logWarning(
            `The setup run's end could not be read: ${failure.message}`,
          ),
        ),
      ),
      scope,
    );
  });
  return launch.pipe(
    starting.withPermitsIfAvailable(1),
    Effect.asVoid,
    // A typed failure only: an interruption (shutdown while a host prompt
    // waits) stays a cancellation, so no notice appears during teardown.
    Effect.catch((error) =>
      error instanceof Cancelled
        ? Effect.void
        : Effect.logError('Setup assistant failed to launch.').pipe(
            Effect.annotateLogs({ data: error }),
            Effect.andThen(
              presentRunFailure(
                ports.present,
                error,
                'Failed to launch setup assistant: ',
              ),
            ),
          ),
    ),
    withLogChannel(CHANNEL),
  );
});
