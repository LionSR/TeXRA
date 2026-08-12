/**
 * Common slice: theme, debug mode, information/instruction messages, and
 * navigation to other surfaces (settings, agents, docs, launcher).
 */

import * as vscode from 'vscode';

import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import { COMMON_COMMANDS, MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type { MainViewInboundHandlerRegistry } from '@shared/schemas';

import type { MainViewInboundHost } from '../mainViewInboundContext';

export function createCommonHandlers(
  host: MainViewInboundHost,
) {
  return {
    [MAIN_VIEW_COMMANDS.THEME_SET]: (m) =>
      host.runWithActiveView((view) => host.handleTheme(m, view)),
    [MAIN_VIEW_COMMANDS.DEBUG_MODE_SET]: (m) =>
      host.runWithActiveView((view) => host.handleDebugMode(m, view)),
    [MAIN_VIEW_COMMANDS.WEBVIEW_READY]: () => host.handleWebviewReady(),
    [MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE]: (m) => {
      vscode.window.showInformationMessage(m.text);
      host.logger.debug(host.channel, `Information message: ${m.text}`);
    },
    [MAIN_VIEW_COMMANDS.SHOW_INSTRUCTION]: (m) =>
      showInstructionWithSuppress(m.key, m.text),
    [MAIN_VIEW_COMMANDS.GET_THEME]: () => host.handleThemeRequest(),
    [MAIN_VIEW_COMMANDS.GET_DEBUG_MODE]: () => host.handleDebugModeRequest(),
    [COMMON_COMMANDS.SWITCH_VIEW]: async (m) => {
      if (m.view === 'dashboard') {
        await safeExecuteCommand('texra.showDashboard', [], host.viewName);
        return;
      }
      if (m.view === 'main') {
        await safeExecuteCommand('texra.showMainView', [], host.viewName);
        return;
      }
      if (m.openInEditor) {
        await safeExecuteCommand(
          'texra.openProgressViewInTab',
          [],
          host.viewName,
        );
        return;
      }
      await safeExecuteCommand(
        'texra.showProgressView',
        [{ inPlace: true }],
        host.viewName,
      );
    },

    [MAIN_VIEW_COMMANDS.SETTINGS_OPEN]: () =>
      safeExecuteCommand('texra.showDashboard', [], host.viewName),
    [MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS]: (m) =>
      safeExecuteCommand(
        'texra.showAgents',
        [m.sessionType === 'toolUse' ? 'toolUse' : undefined],
        host.viewName,
      ),
    [MAIN_VIEW_COMMANDS.OPEN_MODEL_SETTINGS]: () =>
      safeExecuteCommand('texra.showModels', [], host.viewName),
    [MAIN_VIEW_COMMANDS.OPEN_MULTI_AGENT_SETTINGS]: () =>
      safeExecuteCommand('texra.showMultiAgent', [], host.viewName),
    [MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY]: async (m) => {
      if (!m.customDirSet) {
        await safeExecuteCommand('texra.showAgents', [], host.viewName);
        return;
      }
      const dir = await agentDirectories.custom();
      if (dir) {
        await vscode.commands.executeCommand(
          'revealFileInOS',
          vscode.Uri.file(dir),
        );
      }
    },
    [MAIN_VIEW_COMMANDS.OPEN_AGENT_DOCS]: () =>
      safeExecuteCommand('texra.openDoc', ['custom-agents'], host.viewName),
    [MAIN_VIEW_COMMANDS.OPEN_INSTALLATION_DOCS]: () =>
      safeExecuteCommand('texra.openDoc', ['installation'], host.viewName),
  } satisfies Partial<MainViewInboundHandlerRegistry>;
}
