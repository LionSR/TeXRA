/**
 * Frontend listeners for events emitted by agent core/runtime.
 *
 * These listeners bridge the gap between the agent layer (which must not
 * import from @frontend/) and the VS Code UI. The agent emits typed events
 * on the ProgressEventBus; this module subscribes and performs the actual
 * UI operations.
 */
import * as vscode from 'vscode';

import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import { getMainWebview } from '@frontend/system/commandUtils';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import * as logger from '@logger/logUtils';
import { bus } from '@eventBus/ProgressEventBus';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

const CHANNEL = 'agentEventListeners';

function handleRequestOpenFile(
  payload: ProgressEventPayloads['requestOpenFile'],
): void {
  openBuildDisplayIfTex(payload.location, {
    preserveFocus: payload.preserveFocus,
  }).catch((err) =>
    logger.warn(
      CHANNEL,
      `Failed to open file ${payload.location.absolutePath}: ${err}`,
    ),
  );
}

function handleRequestShowInstruction(
  payload: ProgressEventPayloads['requestShowInstruction'],
): void {
  const actions = (payload.actions ?? []).map((a) => ({
    title: a.title,
    callback: () =>
      void vscode.commands.executeCommand(a.command, ...(a.args ?? [])),
  }));

  showInstructionWithSuppress(
    payload.key,
    payload.message,
    actions,
    payload.showSuppress,
  ).catch((err) =>
    logger.warn(CHANNEL, `Failed to show instruction "${payload.key}": ${err}`),
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

  return new vscode.Disposable(() => controller.abort());
}
