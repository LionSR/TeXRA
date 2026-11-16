/**
 * Frontend handlers for presentation events emitted by agent core/runtime.
 *
 * These bridge the gap between the agent layer (which must not import from
 * @frontend/) and the VS Code UI. `createAgentPresentationHost` builds the
 * presentation host `ProgressViewProvider` attaches to the session; this
 * module performs the actual UI operations for each event. Every handler
 * answers with the program that presents its event: the session's
 * presentation layer forks it and reports its failure, so nothing here runs
 * a fiber of its own.
 */
import { Effect } from 'effect';

import {
  withProcessServices,
  type ProcessRuntime,
} from '@texra-ai/harness/host';
import { withLogChannel } from '@texra-ai/harness/plugins';
import {
  toErrorMessage,
  type RequestShowErrorPayload,
  type RequestShowInstructionPayload,
} from '@texra-ai/harness/schemas';
import { setApiKey } from '@commands/api/apiKeyCommands';
import { openGuidePage } from '@frontend/hosts/VscodeExternalOpener';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import type { ShowBuilt } from '@frontend/latex/openBuild';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import type { GuiWindowHost } from '@texra/controllers/session/openGuiWindow';
import {
  INSTRUCTION_ACTION,
  INSTRUCTION_ACTION_BUTTON_LABELS,
  instructionActions,
  READ_GUIDE_BUTTON_LABEL,
  type InstructionAction,
} from '@ui/copy/instructionActions';
import { shownFailureText } from '@ui/copy/modelAccess';
import type { WorkspaceRoots } from '@texra-ai/harness';

const CHANNEL = 'agentEventListeners';

/** Warn-log a step whose failure is a diagnostic rather than non-delivery,
 *  and carry on with the step after it. */
export function warnOnFailure<E>(
  program: Effect.Effect<void, E>,
  what: string,
): Effect.Effect<void> {
  return program.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`${what}: ${toErrorMessage(cause)}`).pipe(
        withLogChannel(CHANNEL),
      ),
    ),
  );
}

/**
 * The program this host runs for each action token the app offers beside
 * an instruction (`instructionActions`): the binding to VS Code commands is
 * the extension's alone.
 */
const INSTRUCTION_ACTION_RUN: Record<
  InstructionAction,
  (roots: WorkspaceRoots, runtime: ProcessRuntime) => Effect.Effect<void, Error>
> = {
  [INSTRUCTION_ACTION.SET_API_KEY]: (roots, runtime) =>
    withProcessServices(runtime, setApiKey(roots)),
  [INSTRUCTION_ACTION.OPEN_CONFIGURATION_GUIDE]: () =>
    openGuidePage('configuration'),
  [INSTRUCTION_ACTION.OPEN_MODELS_DOC]: () => openGuidePage('models'),
};

function handleRequestShowError(
  failure: RequestShowErrorPayload,
): Effect.Effect<void, Error> {
  const { docsPage } = failure;
  // The notice finishes only on dismissal, which no caller waits on: the
  // session forks this program, so the handoff and a post-handoff rejection
  // (the extension host tearing down) are reported there rather than
  // becoming an unhandled rejection. A docs page is offered as a button.
  return vscodeUi
    .ask('error', shownFailureText(failure), {
      items: docsPage ? [READ_GUIDE_BUTTON_LABEL] : [],
    })
    .pipe(
      Effect.flatMap((choice) =>
        choice && docsPage
          ? warnOnFailure(
              openGuidePage(docsPage),
              `Failed to open the ${docsPage} guide`,
            )
          : Effect.void,
      ),
    );
}

function handleRequestShowInstruction(
  roots: WorkspaceRoots,
  runtime: ProcessRuntime,
  payload: RequestShowInstructionPayload,
): Effect.Effect<void, Error> {
  const actions = instructionActions(payload.key).map((token) => {
    const title = INSTRUCTION_ACTION_BUTTON_LABELS[token];
    return {
      title,
      callback: () =>
        warnOnFailure(
          INSTRUCTION_ACTION_RUN[token](roots, runtime),
          `The instruction action "${title}" failed`,
        ),
    };
  });

  // Finishes once VS Code has accepted the dialog, not once the user
  // dismisses it. The "never remind again" path returns without rendering:
  // the user opted out of this notice.
  return showInstructionWithSuppress(
    roots.globalState,
    payload.key,
    payload.message,
    actions,
    payload.showSuppress,
    { deferDismissal: true },
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(
        `Failed to show instruction "${payload.key}": ${toErrorMessage(cause)}`,
      ).pipe(
        withLogChannel(CHANNEL),
        // The instruction may be a launch failure's only surface, so fall
        // back to the error toast rather than dropping it.
        Effect.andThen(handleRequestShowError({ message: payload.message })),
      ),
    ),
  );
}

/**
 * The runtime's notices this extension presents its own way; the window's
 * opening adds the missing-agent banner. The session's `Interactions` (the
 * runtime) owns replaying an event emitted before this host attaches.
 */
export function createAgentPresentationHost(
  roots: WorkspaceRoots,
  runtime: ProcessRuntime,
  showBuilt: ShowBuilt,
): GuiWindowHost['notices'] {
  return {
    // The open-and-build program takes this window's file services from the
    // runtime's context, which the session that forks it does not carry.
    openFile: (payload) =>
      withProcessServices(
        runtime,
        showBuilt([payload.location], {
          preserveFocus: payload.preserveFocus,
        }),
      ),
    requestShowInstruction: (payload) =>
      handleRequestShowInstruction(roots, runtime, payload),
    requestShowError: handleRequestShowError,
  };
}
