// Third-party imports
import { Secrets, withLogChannel } from '@texra-ai/harness/host';
import { Cause, Effect } from 'effect';

// Local imports
import { type RunId, toErrorMessage } from '@texra-ai/harness/schemas';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import {
  announce,
  showLoggedInfoMessage,
} from '@frontend/ui/errorHandlingUtils';
import { launchSetup } from '@texra/controllers/onboarding/setupLaunch';
import type { Session, WorkspaceRoots } from '@texra-ai/harness';
import type { ProcessServices } from '@texra-ai/harness/host';

/** The setup assistant's log channel, for its launch and what follows it. */
export const SETUP_ASSISTANT_CHANNEL = 'SetupAssistant';
const CHANNEL = SETUP_ASSISTANT_CHANNEL;

/**
 * The launch program the command surface runs on the process runtime: it
 * folds every failure — a failed host call, a failed model resolution, a
 * failed root launch — into one error report and a `not-started` result,
 * which is the contract its host caller relies on. An interrupted launch is
 * not a failure: the cause is re-raised so a runtime disposal stays a
 * cancellation instead of a launch-failure notice.
 */
export function launchSetupAssistant(
  roots: WorkspaceRoots,
  /** Where the setup conversation runs: here, or in the service. */
  runSession: Session,
  onAdmitted: (runId: RunId) => Effect.Effect<void, Error>,
  /** Bring the panel's "Connect a model" card into view: the one credential
   *  prompt, which the setup card follows once a credential lands. */
  connectModel: Effect.Effect<void, Error, ProcessServices>,
  /** Reveal the task list, where a setup conversation already running is. */
  showTasks: Effect.Effect<void, Error>,
) {
  return Effect.gen(function* () {
    // Every setup entry point funnels through here (command, status pill,
    // walkthrough, onboarding setup card). The launcher's manual Execute
    // path is deliberately not gated: an explicit user action wins.
    const outcome = yield* launchSetup({
      session: runSession,
      roots,
      secrets: yield* Secrets,
      start: (request) =>
        runSession
          .start({ config: request.config, interactive: true })
          .pipe(Effect.tap((run) => onAdmitted(run.runId))),
    });
    if (outcome === 'already-running') {
      yield* Effect.forkDetach(
        showLoggedInfoMessage(
          CHANNEL,
          'The setup assistant is already running. Follow it in the TeXRA panel.',
        ),
      );
      yield* showTasks.pipe(
        Effect.ignore({ log: 'Warn', message: 'Revealing the task list' }),
      );
      return outcome;
    }
    if (outcome === 'no-model') {
      yield* connectModel;
      return 'not-started' as const;
    }
    return outcome;
  }).pipe(
    Effect.catchCause((cause) => {
      // Shutdown interrupts this fiber while it waits on a host prompt.
      // That is a cancellation, not a launch failure: re-raise it so no
      // error notification appears during teardown.
      if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
      const error = Cause.squash(cause);
      return Effect.logError('Setup assistant failed to launch.').pipe(
        Effect.annotateLogs({ data: error }),
        withLogChannel(CHANNEL),
        Effect.andThen(
          Effect.forkDetach(
            announce(
              CHANNEL,
              vscodeUi.showErrorMessage(
                `Failed to launch setup assistant: ${toErrorMessage(error)}`,
              ),
              undefined,
            ),
          ),
        ),
        Effect.as('not-started' as const),
      );
    }),
  );
}
