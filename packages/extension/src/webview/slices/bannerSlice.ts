/**
 * Banner slice: API-key, agent-config, dependency, and login banners, plus
 * the dependency recheck and banner-sign-in flows.
 */

import * as vscode from 'vscode';

import { AUTH_COMMANDS } from '@auth/constants';
import { globalSM } from '@common/state';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type { MainViewInboundHandlerRegistry } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  checkCoreDependencies,
  getToolDocsCommand,
} from '@utils/system/toolUtils';

import type { MainViewInboundHost } from '../mainViewInboundContext';

export function createBannerHandlers(host: MainViewInboundHost) {
  return {
    [MAIN_VIEW_COMMANDS.SHOW_API_KEY_BANNER]: (m) => host.postToActiveView(m),
    [MAIN_VIEW_COMMANDS.HIDE_API_KEY_BANNER]: (m) => host.postToActiveView(m),
    [MAIN_VIEW_COMMANDS.SHOW_AGENT_CONFIG_BANNER]: (m) =>
      host.postToActiveView(m),
    [MAIN_VIEW_COMMANDS.HIDE_AGENT_CONFIG_BANNER]: (m) =>
      host.postToActiveView(m),
    [MAIN_VIEW_COMMANDS.SHOW_DEPENDENCY_BANNER]: (m) =>
      host.postToActiveView(m),
    [MAIN_VIEW_COMMANDS.HIDE_DEPENDENCY_BANNER]: (m) =>
      host.postToActiveView(m),
    [MAIN_VIEW_COMMANDS.OPEN_INSTALL_GUIDE]: (m) => {
      const docsCommand = getToolDocsCommand(m.tool);
      if (!docsCommand) return;

      const [command, ...args] = docsCommand.split(',');
      return safeExecuteCommand(command, args, host.viewName);
    },
    [MAIN_VIEW_COMMANDS.RECHECK_DEPENDENCIES]: async () => {
      const view = host.getActiveView();
      if (!view) {
        return;
      }
      const missingTools = await checkCoreDependencies(true);
      view.webview.postMessage(
        missingTools.length === 0
          ? { command: MAIN_VIEW_COMMANDS.HIDE_DEPENDENCY_BANNER }
          : {
              command: MAIN_VIEW_COMMANDS.SHOW_DEPENDENCY_BANNER,
              missingTools: [...missingTools],
            },
      );
    },
    [MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER]: (m) => host.postToActiveView(m),
    [MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER]: (m) => host.postToActiveView(m),
    [MAIN_VIEW_COMMANDS.SIGN_IN_FROM_BANNER]: async () => {
      try {
        const authenticated = await vscode.commands.executeCommand<boolean>(
          AUTH_COMMANDS.SIGN_IN,
        );
        if (authenticated) {
          host.postToActiveView({
            command: MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER,
          });
          await host.refreshAfterCredentialChange();
        }
      } catch (error) {
        host.logger.debug(
          host.channel,
          `Sign-in from banner failed: ${toErrorMessage(error)}`,
        );
      }
    },
    [MAIN_VIEW_COMMANDS.DISMISS_LOGIN_BANNER]: async () => {
      await globalSM.update(GlobalStateKey.LOGIN_BANNER_DISMISSED, true);
    },
    [MAIN_VIEW_COMMANDS.DISMISS_ORCHESTRATOR_BANNER]: async () => {
      await globalSM.update(GlobalStateKey.ORCHESTRATOR_BANNER_DISMISSED, true);
    },
  } satisfies Partial<MainViewInboundHandlerRegistry>;
}
