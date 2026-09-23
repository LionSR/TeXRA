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
import { Cause, Effect } from 'effect';
import * as vscode from 'vscode';

import {
  type HostInteractions,
  type HostPresentation,
  type PresentationEventHandlers,
  type RuntimePresentationEvent,
  type RuntimePresentationEventPayloads,
  type SessionHandle,
} from '@agent/runtime';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import { withLogChannel } from '@logger/effectLog';
import type { StateStore } from '@platform/interfaces';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import {
  INSTRUCTION_ACTION,
  type InstructionAction,
  type RequestEnsureProgressViewPayload,
  type RequestShowErrorPayload,
  type RequestShowInstructionPayload,
  type ShowAgentConfigBannerPayload,
} from '@shared/schemas';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

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

const revealProgressView = Effect.tryPromise({
  try: async () => {
    await vscode.commands.executeCommand('texra.showProgressView');
  },
  catch: ensureError,
});

/**
 * Maps the host-agnostic action tokens the agent core emits to the VS Code
 * command (and button label) this host invokes. Keeping this table here — not
 * in the agent core — is what lets the core stay free of `texra.*` command IDs.
 */
const INSTRUCTION_ACTION_VIEW: Record<
  InstructionAction,
  { title: string; command: string; args?: unknown[] }
> = {
  [INSTRUCTION_ACTION.SET_API_KEY]: {
    title: 'Set API Key',
    command: 'texra.setApiKey',
  },
  [INSTRUCTION_ACTION.OPEN_CONFIGURATION_GUIDE]: {
    title: 'Open Settings Guide',
    command: 'texra.openDoc',
    args: ['configuration'],
  },
  [INSTRUCTION_ACTION.OPEN_MODELS_DOC]: {
    title: 'Model Documentation',
    command: 'texra.openDoc',
    args: ['models'],
  },
};

function handleRequestShowError({
  message,
}: RequestShowErrorPayload): Effect.Effect<void, Error> {
  // `showErrorMessage` settles only on dismissal, which no caller waits on:
  // the session forks this program, so the handoff and a post-handoff
  // rejection (the extension host tearing down) are reported there rather
  // than becoming an unhandled rejection.
  return Effect.tryPromise({
    try: async () => {
      await vscode.window.showErrorMessage(message);
    },
    catch: ensureError,
  });
}

function handleRequestShowInstruction(
  globalState: StateStore,
  payload: RequestShowInstructionPayload,
): Effect.Effect<void, Error> {
  const actions = (payload.actions ?? []).map((token) => {
    const view = INSTRUCTION_ACTION_VIEW[token];
    return {
      title: view.title,
      callback: () =>
        Effect.sync(() => {
          void vscode.commands.executeCommand(
            view.command,
            ...(view.args ?? []),
          );
        }),
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

function handleShowAgentConfigBanner(
  payload: ShowAgentConfigBannerPayload,
  progressViewProvider: ProgressViewProvider,
): Effect.Effect<void> {
  return progressViewProvider.showAgentConfigBanner(
    payload.agentName,
    payload.category,
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
      revealProgressView,
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
    const selection = yield* Effect.tryPromise({
      try: async () =>
        await vscode.window.showInformationMessage(
          `"${fb.agentName}" is processing ${fb.inputName} with ${fb.modelName}${outputPart}.`,
          {
            modal: false,
            detail:
              'TeXRA agents run in the background; track them in the Progress view.',
          },
          'Show Progress View',
        ),
      catch: ensureError,
    });
    if (!selection) return;
    // The toast handoff already established delivery; a failed retry is
    // a diagnostic, not non-delivery, so it must not downgrade the event.
    yield* warnOnFailure(
      revealProgressView,
      'Failed to retry the progress-view reveal',
    );
  });
}

/**
 * Builds the extension's presentation host over its handler map. Every
 * `RuntimePresentationEvent` key is required by
 * `PresentationEventHandlers<RuntimePresentationEventPayloads, HostPresentation>`
 * — omitting one here is a compile error rather than a silently dropped event
 * (CLAUDE.md, silent degradation), replacing the previous `switch`'s
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
  session: SessionHandle,
): Pick<HostInteractions, 'emit'> {
  const handlers: PresentationEventHandlers<
    RuntimePresentationEventPayloads,
    HostPresentation
  > = {
    // The open-and-build program takes this window's file services from the
    // runtime's context, which the session that forks it does not carry.
    requestOpenFile: (payload) =>
      Effect.flatMap(runtime.contextEffect, (context) =>
        Effect.provideContext(
          openBuildDisplayIfTex(session, payload.location, {
            preserveFocus: payload.preserveFocus,
          }),
          context,
        ),
      ).pipe(Effect.asVoid),
    requestShowInstruction: (payload) =>
      handleRequestShowInstruction(globalState, payload),
    showAgentConfigBanner: (payload) =>
      handleShowAgentConfigBanner(payload, progressViewProvider),
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
