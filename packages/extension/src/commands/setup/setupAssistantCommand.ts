// Third-party imports
import { withLogChannel } from '@texra-ai/harness/host';
import { Cause, Effect } from 'effect';

// Local imports
import { toErrorMessage } from '@texra-ai/harness/schemas';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import {
  announce,
  showLoggedInfoMessage,
} from '@frontend/ui/errorHandlingUtils';
import { launchSetup } from '@texra/controllers/onboarding/setupLaunch';
import type { HostRunActions } from '@texra/controllers/session/hostRunActions';
import type { Session, WorkspaceRoots } from '@texra-ai/harness';
import type { ProcessServices } from '@texra-ai/harness/host';

/** The setup assistant's log channel, for its launch and what follows it. */
export const SETUP_ASSISTANT_CHANNEL = 'SetupAssistant';
const CHANNEL = SETUP_ASSISTANT_CHANNEL;

/**
 * The launch program the command surface runs on the process runtime: it
 * turns every failure — a failed host call, a failed model resolution — into
 * one error report and a `not-started` result, which is the contract its
 * host caller relies on; a failed root launch is `not-started` too, reported
 * by the window's launcher. An interrupted launch is not a failure: the
 * cause is re-raised so a runtime disposal stays a cancellation instead of a
 * launch-failure notice.
 */
export const launchSetupAssistant = Effect.fn('launchSetupAssistant')(
  function* (
    roots: WorkspaceRoots,
    runSession: Pick<Session, 'view'>,
    start: HostRunActions['runValidated'],
    connectModel: Effect.Effect<void, Error, ProcessServices>,
    showTasks: Effect.Effect<void, Error>,
  ) {
    // Every setup entry point funnels through here (command, status pill,
    // walkthrough, onboarding setup card). The launcher's manual Execute
    // path is deliberately not gated: an explicit user action wins.
    const outcome = yield* launchSetup({ session: runSession, roots, start });
    if (outcome === 'already-running') {
      yield* Effect.forkDetach(
        showLoggedInfoMessage(
          CHANNEL,
          'The setup assistant is already running. Follow it in the TeXRA panel.',
        ),
      );
      yield* showTasks.pipe(
        Effect.ignore({ log: 'Warn', message: 'Revealing the task list' }),
        withLogChannel(CHANNEL),
      );
      return outcome;
    }
    if (outcome === 'no-model') {
      yield* connectModel;
      return 'not-started' as const;
    }
    return outcome;
  },
  Effect.catchCause((cause) => {
    // Shutdown interrupts this fiber while it waits on a host prompt.
    // That is a cancellation, not a launch failure: re-raise it so no
    // error notification appears during teardown.
    if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
    const error = Cause.squash(cause);
    // A failure before the launch (no model, a request refused): the
    // window's launcher shows its own refusal, which `launchSetup`
    // answers as `not-started`.
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
