// Third-party imports
import { Secrets, withLogChannel } from '@texra-ai/harness/host';
import { Cause, Effect, Schema } from 'effect';

// Local imports
import {
  AgentConfigSchema,
  agentName,
  type RunId,
  isLiveRun,
  toErrorMessage,
} from '@texra-ai/harness/schemas';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import {
  announce,
  showLoggedInfoMessage,
} from '@frontend/ui/errorHandlingUtils';
import { SETUP_INSTRUCTION } from '@texra/controllers/onboarding/setupLaunch';
import { resolveSetupLaunchModel } from '@texra/model/setupCredentialAccess';
import { SETUP_AGENT_NAME } from '@texra/shared/constants/agents';
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
    // walkthrough, onboarding setup card), so one guard covers them all:
    // a second concurrent setup conversation would race the first one's
    // installs and config writes. The launcher's manual Execute path is
    // deliberately not gated — an explicit user action wins.
    const running = runSession.view.current().runs.values();
    if (
      [...running].some(
        (run) =>
          isLiveRun(run) &&
          run.identity.kind === 'agent' &&
          agentName(run.identity.agent) === SETUP_AGENT_NAME,
      )
    ) {
      yield* Effect.forkDetach(
        showLoggedInfoMessage(
          CHANNEL,
          'The setup assistant is already running. Follow it in the TeXRA panel.',
        ),
      );
      yield* showTasks.pipe(
        Effect.ignore({ log: 'Warn', message: 'Revealing the task list' }),
      );
      return 'already-running' as const;
    }

    // The launch model the credential predicate every host shares decides:
    // adapter-level checks, so a blank env key does not count and fail later
    // as "No model is available". No model is the missing-credential case; a
    // check that cannot be answered fails to the launch-failure report below.
    const model = yield* resolveSetupLaunchModel(roots, yield* Secrets);
    if (model === null) {
      yield* connectModel;
      return 'not-started' as const;
    }

    const config = Schema.decodeUnknownSync(AgentConfigSchema)({
      agent: 'setup',
      model,
      instruction: SETUP_INSTRUCTION,
    });

    // The conversation, from its start through its end. A failure once it
    // started is its result row's to show, not a failure to launch.
    yield* runSession.start({ config, interactive: true }).pipe(
      Effect.tap((run) => onAdmitted(run.runId)),
      Effect.flatMap((run) =>
        run.result.pipe(
          Effect.asVoid,
          Effect.catch((failure) =>
            Effect.logDebug(`The setup run failed: ${failure.message}`),
          ),
        ),
      ),
    );
    return 'launched' as const;
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
