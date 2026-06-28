/**
 * Frontend listeners for events emitted by agent core/runtime.
 *
 * These listeners bridge the gap between the agent layer (which must not
 * import from @frontend/) and the VS Code UI. The agent emits typed events
 * on the ProgressEventBus; this module subscribes and performs the actual
 * UI operations.
 */
import * as vscode from 'vscode';

import { isRuntimeProgressViewVisible } from '@agent/runtime/progressViewCommands';
import { attachDefaultTerminalResultToast } from '@agent/runtime/terminalResultToast';
import { toErrorMessage } from '@common/errors';
import { bus, INSTRUCTION_ACTION } from '@eventBus/ProgressEventBus';
import type {
  InstructionAction,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import { getMainWebview } from '@frontend/system/commandUtils';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import * as logger from '@logger/logUtils';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';

const CHANNEL = 'agentEventListeners';

function handleRequestOpenFile(
  payload: ProgressEventPayloads['requestOpenFile'],
): void {
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
  payload: ProgressEventPayloads['requestShowInstruction'],
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
  payload: ProgressEventPayloads['showAgentConfigBanner'],
): Promise<void> {
  const view = await getMainWebview(CHANNEL);
  view?.webview.postMessage({
    command: MAIN_VIEW_COMMANDS.SHOW_AGENT_CONFIG_BANNER,
    agentName: payload.agentName,
    customDirSet: true,
  });
}

function handleRequestShowError({
  message,
}: ProgressEventPayloads['requestShowError']): void {
  void vscode.window.showErrorMessage(message);
}

async function handleRequestEnsureProgressView(
  payload: ProgressEventPayloads['requestEnsureProgressView'],
): Promise<void> {
  await vscode.commands.executeCommand('texra.showProgressView');

  // If the view is still not visible after attempting to open it and a
  // fallback notification was provided, show a toast as a last resort.
  // This preserves the original two-check semantics that relied on await.
  const fb = payload.fallbackNotification;
  if (fb && !isRuntimeProgressViewVisible()) {
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
 * Register all agent→frontend event listeners.
 * Returns a Disposable that cleans up all subscriptions.
 */
export function registerAgentEventListeners(): vscode.Disposable {
  const controller = new AbortController();
  const { signal } = controller;

  bus.on('requestOpenFile', handleRequestOpenFile, { signal });
  bus.on('requestShowInstruction', handleRequestShowInstruction, { signal });
  bus.on(
    'showAgentConfigBanner',
    (payload) => void handleShowAgentConfigBanner(payload),
    { signal },
  );
  bus.on('requestShowError', handleRequestShowError, { signal });
  bus.on(
    'requestEnsureProgressView',
    (payload) => void handleRequestEnsureProgressView(payload),
    { signal },
  );

  // Terminal-error toasts now come from the run's `result` event (the lifecycle
  // no longer emits them directly). The same shared helper every host uses
  // re-emits `requestShow*` through `extensionAgentRuntimeHost` (= `bus.emit`),
  // reaching the `bus.on` handlers registered above exactly once.
  const detachResult = attachDefaultTerminalResultToast(
    extensionAgentRuntimeHost,
  );
  signal.addEventListener('abort', detachResult, { once: true });

  return new vscode.Disposable(() => controller.abort());
}
