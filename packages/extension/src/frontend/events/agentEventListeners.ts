/**
 * Frontend handlers for presentation events emitted by agent core/runtime.
 *
 * These bridge the gap between the agent layer (which must not import from
 * @frontend/) and the VS Code UI. `createAgentPresentationHost` builds the
 * presentation host `ProgressViewProvider` attaches to the session; this
 * module performs the actual UI operations for each event. Every handler
 * answers with the program that presents its event: the session's
 * presentation plane forks it and reports its failure, so nothing here runs
 * a fiber of its own.
 */
import { Cause, Effect, Scope } from 'effect';

import { withProcessServices, type ProcessRuntime, type HostPresentation, type RuntimePresentationEvent, type RuntimePresentationEventPayloads, type HostInteractions, type PresentationEventHandlers, withLogChannel } from '@texra-ai/harness/host';
import {
  toErrorMessage,
  INSTRUCTION_ACTION,
  type InstructionAction,
  type RequestEnsureProgressViewPayload,
  type RequestShowErrorPayload,
  type RequestShowInstructionPayload,
} from '@texra-ai/harness/schemas';
import { setApiKey } from '@commands/api/apiKeyCommands';
import { openGuidePage } from '@frontend/hosts/VscodeExternalOpener';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import type { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import type { WorkspaceRoots } from '@texra-ai/harness';
import type { StateStore } from '@texra-ai/harness/host';

const CHANNEL = 'agentEventListeners';

/** Warn-log a step whose failure is a diagnostic rather than non-delivery,
 *  and carry on with the step after it. */
function warnOnFailure<E>(
  program: Effect.Effect<void, E>,
  what: string,
): Effect.Effect<void> {
  return program.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`${what}: ${toErrorMessage(Cause.squash(cause))}`).pipe(
        withLogChannel(CHANNEL),
      ),
    ),
  );
}

/**
 * Maps the host-agnostic action tokens the agent core emits to the button
 * label and the program this host runs for it. Keeping this table here — not
 * in the agent core — is what lets the core stay free of host actions.
 */
const INSTRUCTION_ACTION_VIEW: Record<
  InstructionAction,
  {
    title: string;
    run: (
      roots: WorkspaceRoots,
      runtime: ProcessRuntime,
    ) => Effect.Effect<void, Error>;
  }
> = {
  [INSTRUCTION_ACTION.SET_API_KEY]: {
    title: 'Set API Key',
    run: (roots, runtime) => withProcessServices(runtime, setApiKey(roots)),
  },
  [INSTRUCTION_ACTION.OPEN_CONFIGURATION_GUIDE]: {
    title: 'Open Settings Guide',
    run: () => openGuidePage('configuration'),
  },
  [INSTRUCTION_ACTION.OPEN_MODELS_DOC]: {
    title: 'Model Documentation',
    run: () => openGuidePage('models'),
  },
};

function handleRequestShowError({
  message,
  docsPage,
}: RequestShowErrorPayload): Effect.Effect<void, Error> {
  // The notice settles only on dismissal, which no caller waits on: the
  // session forks this program, so the handoff and a post-handoff rejection
  // (the extension host tearing down) are reported there rather than
  // becoming an unhandled rejection. A docs page is offered as a button.
  return vscodeUi
    .error(message, { items: docsPage ? ['View Docs'] : [] })
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
  globalState: StateStore,
  roots: WorkspaceRoots,
  runtime: ProcessRuntime,
  payload: RequestShowInstructionPayload,
): Effect.Effect<void, Error> {
  const actions = (payload.actions ?? []).map((token) => {
    const view = INSTRUCTION_ACTION_VIEW[token];
    return {
      title: view.title,
      callback: () =>
        warnOnFailure(
          view.run(roots, runtime),
          `The instruction action "${view.title}" failed`,
        ),
    };
  });

  // Settles once VS Code has accepted the dialog, not once the user
  // dismisses it. The "never remind again" path returns without rendering:
  // the user opted out of this notice.
  return showInstructionWithSuppress(
    globalState,
    payload.key,
    payload.message,
    actions,
    payload.showSuppress,
    { deferDismissal: true },
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(
        `Failed to show instruction "${payload.key}": ${toErrorMessage(Cause.squash(cause))}`,
      ).pipe(
        withLogChannel(CHANNEL),
        // The instruction may be a launch failure's only surface, so fall
        // back to the error toast rather than dropping it.
        Effect.andThen(handleRequestShowError({ message: payload.message })),
      ),
    ),
  );
}

function handleRequestEnsureProgressView(
  payload: RequestEnsureProgressViewPayload,
  progressViewProvider: ProgressViewProvider,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    if (progressViewProvider.isViewVisible()) return;

    // A failed reveal is a diagnostic, not non-delivery: fall through to the
    // visibility re-check and, when provided, the toast handoff below (#10554).
    yield* warnOnFailure(
      progressViewProvider.showProgressView(),
      'Failed to reveal the progress view',
    );

    // Delivery is the reveal actually becoming visible, not the reveal command
    // resolving. Re-check after the command before treating the event as
    // presented.
    if (progressViewProvider.isViewVisible()) return;

    const fb = payload.fallbackNotification;
    if (!fb) return;

    // If the view is still not visible after attempting to open it and a
    // fallback notification was provided, show a toast as a last resort.
    // The toast itself is the delivered surface when the view cannot be made
    // visible: a successful handoff means the event was presented even if
    // the user dismisses it without retrying the reveal.
    const outputPart = fb.outputInfo ? ` (${fb.outputInfo})` : '';
    const selection = yield* vscodeUi.info(
      `"${fb.agentName}" is processing ${fb.inputName} with ${fb.modelName}${outputPart}.`,
      {
        modal: false,
        detail:
          'TeXRA agents run in the background; track them under Tasks in the TeXRA panel.',
        items: ['Show Tasks'],
      },
    );
    if (!selection) return;
    // The toast handoff already established delivery; a failed retry is
    // a diagnostic, not non-delivery, so it must not downgrade the event.
    yield* warnOnFailure(
      progressViewProvider.showProgressView(),
      'Failed to retry the progress-view reveal',
    );
  });
}

/**
 * Builds the extension's presentation host over its handler map. Every
 * `RuntimePresentationEvent` key is required by
 * `PresentationEventHandlers<RuntimePresentationEventPayloads, HostPresentation>`
 * — omitting one here is a compile error rather than a silently dropped event
 * (AGENTS.md, silent degradation), replacing the previous `switch`'s
 * `never`-typed `default` guard. The five presentation events handled here are
 * the extension's own dispatch, replacing a previous per-host
 * presentation-event bus and its static router (a duplicate replay mechanism —
 * see #9251). `SessionHostInteractions` (the runtime) owns replaying an event
 * emitted before this host attaches, via
 * `AgentRuntimeEmitOptions.replayWhenAttached`.
 */
export function createAgentPresentationHost(
  progressViewProvider: ProgressViewProvider,
  globalState: StateStore,
  runtime: ProcessRuntime,
  roots: WorkspaceRoots,
  /** The view's scope, which a scheduled PDF viewer open runs in. */
  scope: Scope.Scope,
): Pick<HostInteractions, 'emit'> {
  const handlers: PresentationEventHandlers<
    RuntimePresentationEventPayloads,
    HostPresentation
  > = {
    // The open-and-build program takes this window's file services from the
    // runtime's context, which the session that forks it does not carry, and
    // schedules the PDF viewer in the view's scope.
    requestOpenFile: (payload) =>
      withProcessServices(
        runtime,
        openBuildDisplayIfTex(roots, payload.location, {
          preserveFocus: payload.preserveFocus,
        }).pipe(Effect.provideService(Scope.Scope, scope)),
      ).pipe(Effect.asVoid),
    requestShowInstruction: (payload) =>
      handleRequestShowInstruction(globalState, roots, runtime, payload),
    showAgentConfigBanner: (payload) =>
      progressViewProvider.showAgentConfigBanner(payload.agentName),
    requestShowError: handleRequestShowError,
    requestEnsureProgressView: (payload) =>
      handleRequestEnsureProgressView(payload, progressViewProvider),
  };
  return {
    emit<K extends RuntimePresentationEvent>(
      event: K,
      payload: RuntimePresentationEventPayloads[K],
    ): HostPresentation {
      return handlers[event](payload);
    },
  };
}
