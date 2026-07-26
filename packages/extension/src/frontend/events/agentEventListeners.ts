/**
 * Frontend handlers for presentation events emitted by agent core/runtime.
 *
 * These bridge the gap between the agent layer (which must not import from
 * @frontend/) and the VS Code UI. `createAgentPresentationHost` builds the
 * `AgentRuntimeHost` the extension's `HostInteractions` adapter forwards
 * `emit` calls to (see `progressView/extensionHostInteractions.ts`); this
 * module performs the actual UI operations for each event.
 */
import * as vscode from 'vscode';

import type {
  AgentRuntimeEvent,
  AgentRuntimeEventPayloads,
  AgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';
import { isRuntimePresentationEvent } from '@agent/runtime/runtimePresentationEvents';
import {
  isProgressBackendInteractionEvent,
  type ProgressBackendInteractionPayloads,
} from '@controllers/progressView/backend/events/ProgressInteractionHandler';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import { getMainWebview } from '@frontend/system/commandUtils';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import { emitExtensionInteractionEvent } from '@frontend/events/extensionInteractionEvents';
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

function handleRequestOpenFile(payload: RequestOpenFilePayload): void {
  openBuildDisplayIfTex(payload.location, {
    preserveFocus: payload.preserveFocus,
  }).catch((err) =>
    logger.warn(
      CHANNEL,
      `Failed to open file ${payload.location.absolutePath}: ${toErrorMessage(err)}`,
    ),
  );
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

function handleRequestShowInstruction(
  payload: RequestShowInstructionPayload,
): void {
  const actions = (payload.actions ?? []).map((token) => {
    const view = INSTRUCTION_ACTION_VIEW[token];
    return {
      title: view.title,
      callback: () =>
        void vscode.commands.executeCommand(view.command, ...(view.args ?? [])),
    };
  });

  showInstructionWithSuppress(
    payload.key,
    payload.message,
    actions,
    payload.showSuppress,
  ).catch((err) =>
    logger.warn(
      CHANNEL,
      `Failed to show instruction "${payload.key}": ${toErrorMessage(err)}`,
    ),
  );
}

async function handleShowAgentConfigBanner(
  payload: ShowAgentConfigBannerPayload,
): Promise<void> {
  const view = await getMainWebview(CHANNEL);
  view?.webview.postMessage({
    command: MAIN_VIEW_COMMANDS.SHOW_AGENT_CONFIG_BANNER,
    agentName: payload.agentName,
    customDirSet: true,
  });
}

function handleRequestShowError({ message }: RequestShowErrorPayload): void {
  void vscode.window.showErrorMessage(message);
}

async function handleRequestEnsureProgressView(
  payload: RequestEnsureProgressViewPayload,
  progressViewProvider: ProgressViewProvider,
): Promise<void> {
  if (progressViewProvider.isViewVisible()) return;

  await vscode.commands.executeCommand('texra.showProgressView');

  // If the view is still not visible after attempting to open it and a
  // fallback notification was provided, show a toast as a last resort.
  // This preserves the original two-check semantics that relied on await.
  const fb = payload.fallbackNotification;
  if (fb && !progressViewProvider.isViewVisible()) {
    const selection = await vscode.window.showInformationMessage(
      `TeXRA Agent Started: "${fb.agentName}" is processing ${fb.inputName} with ${fb.modelName} ${fb.outputInfo}. View in ProgressBoard for progress.`,
      {
        modal: false,
        detail:
          'TeXRA agents run in the background and their progress can be tracked in the ProgressBoard.',
      },
      'Show ProgressBoard',
    );
    if (selection) {
      await vscode.commands.executeCommand('texra.showProgressView');
    }
  }
}

/**
 * Build the `AgentRuntimeHost` the extension's `HostInteractions` adapter
 * forwards `emit` calls to (`createExtensionHostInteractions`'s `runtimeHost`
 * option, wired in `ProgressViewProvider`'s constructor).
 *
 * Progress-view interaction events (tool-edit approval prompts, bypass-state
 * pushes) route through the existing `extensionInteractionEvents` sink
 * unchanged; the five presentation events below are the extension's own
 * dispatch, replacing a previous per-host presentation-event bus and its
 * static router (a duplicate replay mechanism — see #9251).
 * `SessionHostInteractions` (the runtime) owns replaying an event emitted
 * before this host attaches, via `AgentRuntimeEmitOptions.replayWhenAttached`.
 */
export function createAgentPresentationHost(
  progressViewProvider: ProgressViewProvider,
): AgentRuntimeHost {
  return {
    emit<K extends AgentRuntimeEvent>(
      event: K,
      payload: AgentRuntimeEventPayloads[K],
    ): void {
      if (isProgressBackendInteractionEvent(event)) {
        emitExtensionInteractionEvent(
          event,
          payload as ProgressBackendInteractionPayloads[typeof event],
        );
        return;
      }
      if (!isRuntimePresentationEvent(event)) return;
      switch (event) {
        case 'requestOpenFile':
          handleRequestOpenFile(payload as RequestOpenFilePayload);
          return;
        case 'requestShowInstruction':
          handleRequestShowInstruction(
            payload as RequestShowInstructionPayload,
          );
          return;
        case 'showAgentConfigBanner':
          void handleShowAgentConfigBanner(
            payload as ShowAgentConfigBannerPayload,
          );
          return;
        case 'requestShowError':
          handleRequestShowError(payload as RequestShowErrorPayload);
          return;
        case 'requestEnsureProgressView':
          void handleRequestEnsureProgressView(
            payload as RequestEnsureProgressViewPayload,
            progressViewProvider,
          );
          return;
        default:
          return;
      }
    },
  };
}
