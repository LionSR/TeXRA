/**
 * Frontend handlers for presentation events emitted by agent core/runtime.
 *
 * These bridge the gap between the agent layer (which must not import from
 * @frontend/) and the VS Code UI. `createAgentPresentationHost` builds the
 * presentation host the extension's `HostInteractions` adapter forwards
 * `emit` calls to (see `progressView/extensionHostInteractions.ts`); this
 * module performs the actual UI operations for each event.
 */
import * as vscode from 'vscode';

import {
  dispatchPresentationEvent,
  toPresentationDelivery,
  type PresentationDelivery,
  type PresentationEventHandlers,
  type RuntimePresentationEvent,
  type RuntimePresentationEventPayloads,
  type SessionHostInteractions,
} from '@agent/runtime';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import { getMainWebview } from '@frontend/system/commandUtils';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import * as logger from '@logger/logUtils';
import type { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import {
  INSTRUCTION_ACTION,
  type InstructionAction,
  type RequestEnsureProgressViewPayload,
  type RequestOpenFilePayload,
  type RequestShowErrorPayload,
  type RequestShowInstructionPayload,
  type ShowAgentConfigBannerPayload,
} from '@shared/schemas';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'agentEventListeners';

function handleRequestOpenFile(
  payload: RequestOpenFilePayload,
): Promise<boolean> {
  return openBuildDisplayIfTex(payload.location, {
    preserveFocus: payload.preserveFocus,
  }).catch((err) => {
    logger.warn(
      CHANNEL,
      `Failed to open file ${payload.location.absolutePath}: ${toErrorMessage(err)}`,
    );
    return false;
  });
}

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

async function handleRequestShowInstruction(
  payload: RequestShowInstructionPayload,
): Promise<boolean> {
  const actions = (payload.actions ?? []).map((token) => {
    const view = INSTRUCTION_ACTION_VIEW[token];
    return {
      title: view.title,
      callback: () =>
        void vscode.commands.executeCommand(view.command, ...(view.args ?? [])),
    };
  });

  try {
    // Report delivery once VS Code has accepted the dialog, not once the user
    // dismisses it: `validateModelExists` awaits this emit, and keeping launch
    // cleanup tied to modal dismissal would leave the reserved stream STARTING
    // for as long as the notification is open.
    await showInstructionWithSuppress(
      payload.key,
      payload.message,
      actions,
      payload.showSuppress,
      { deferDismissal: true },
    );
    // The "never remind again" suppression path also reports delivered:
    // `showInstructionWithSuppress` returns without rendering when the user
    // previously opted out of this key, and firing the caller's generic
    // fallback then would resurface the same notice through a toast the user
    // cannot suppress. The launch error itself still surfaces through the
    // failed run.
    return true;
  } catch (err) {
    logger.warn(
      CHANNEL,
      `Failed to show instruction "${payload.key}": ${toErrorMessage(err)}`,
    );
    return false;
  }
}

async function handleShowAgentConfigBanner(
  payload: ShowAgentConfigBannerPayload,
): Promise<boolean> {
  try {
    const view = await getMainWebview(CHANNEL);
    if (!view) return false;
    return (
      (await view.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.SHOW_AGENT_CONFIG_BANNER,
        agentName: payload.agentName,
        customDirSet: true,
      })) !== false
    );
  } catch (err) {
    logger.warn(
      CHANNEL,
      `Failed to show agent config banner for "${payload.agentName}": ${toErrorMessage(err)}`,
    );
    return false;
  }
}

function handleRequestShowError({ message }: RequestShowErrorPayload): boolean {
  try {
    // Delivery is the toast handoff: `showErrorMessage` resolves only on
    // dismissal, which no caller should wait on, so report once VS Code has
    // accepted the request. The returned Thenable is still observed so a
    // post-handoff rejection (e.g. while the extension host is tearing down)
    // is logged instead of becoming an unhandled rejection.
    const toast = vscode.window.showErrorMessage(message);
    void Promise.resolve(toast).catch((err: unknown) => {
      logger.warn(
        CHANNEL,
        `Error toast failed after handoff: ${toErrorMessage(err)}`,
      );
    });
    return true;
  } catch (err) {
    logger.warn(
      CHANNEL,
      `Failed to show the error toast: ${toErrorMessage(err)}`,
    );
    return false;
  }
}

async function handleRequestEnsureProgressView(
  payload: RequestEnsureProgressViewPayload,
  progressViewProvider: ProgressViewProvider,
): Promise<boolean> {
  if (progressViewProvider.isViewVisible()) return true;

  await vscode.commands.executeCommand('texra.showProgressView');

  // Delivery is the reveal actually becoming visible, not the reveal command
  // resolving. Re-check after the command before treating the event as
  // presented.
  if (progressViewProvider.isViewVisible()) return true;

  const fb = payload.fallbackNotification;
  if (fb) {
    // If the view is still not visible after attempting to open it and a
    // fallback notification was provided, show a toast as a last resort.
    // The toast itself is the delivered surface when the view cannot be made
    // visible: a successful handoff means the event was presented even if
    // the user dismisses it without retrying the reveal.
    const outputPart = fb.outputInfo ? ` (${fb.outputInfo})` : '';
    const selection = await vscode.window.showInformationMessage(
      `"${fb.agentName}" is processing ${fb.inputName} with ${fb.modelName}${outputPart}.`,
      {
        modal: false,
        detail:
          'TeXRA agents run in the background; track them in the Progress view.',
      },
      'Show Progress View',
    );
    if (selection) {
      try {
        await vscode.commands.executeCommand('texra.showProgressView');
      } catch (err) {
        // The toast handoff already established delivery; a failed retry is
        // a diagnostic, not non-delivery, so it must not downgrade the event.
        logger.warn(
          CHANNEL,
          `Failed to retry the progress-view reveal: ${toErrorMessage(err)}`,
        );
      }
    }
    return true;
  }

  return false;
}

/**
 * Builds the extension's presentation-event handler map. Every
 * `RuntimePresentationEvent` key is required by
 * `PresentationEventHandlers<RuntimePresentationEventPayloads>` — omitting
 * one here is a compile error rather than a silently dropped event (CLAUDE.md,
 * silent degradation), replacing the previous `switch`'s `never`-typed
 * `default` guard. The five presentation events handled here are the
 * extension's own dispatch, replacing a previous per-host presentation-event
 * bus and its static router (a duplicate replay mechanism — see #9251).
 * `SessionHostInteractions` (the runtime) owns replaying an event emitted
 * before this host attaches, via `AgentRuntimeEmitOptions.replayWhenAttached`.
 */
function createPresentationEventHandlers(
  progressViewProvider: ProgressViewProvider,
): PresentationEventHandlers<RuntimePresentationEventPayloads> {
  return {
    requestOpenFile: handleRequestOpenFile,
    requestShowInstruction: handleRequestShowInstruction,
    showAgentConfigBanner: handleShowAgentConfigBanner,
    requestShowError: handleRequestShowError,
    requestEnsureProgressView: (payload) =>
      handleRequestEnsureProgressView(payload, progressViewProvider).catch(
        (err) => {
          logger.warn(
            CHANNEL,
            `Failed to reveal the progress view: ${toErrorMessage(err)}`,
          );
          return false;
        },
      ),
  };
}

export function createAgentPresentationHost(
  progressViewProvider: ProgressViewProvider,
): Pick<SessionHostInteractions, 'emit'> {
  const handlers = createPresentationEventHandlers(progressViewProvider);
  return {
    emit<K extends RuntimePresentationEvent>(
      event: K,
      payload: RuntimePresentationEventPayloads[K],
    ): PresentationDelivery {
      return toPresentationDelivery(
        dispatchPresentationEvent(handlers, event, payload),
      );
    },
  };
}
