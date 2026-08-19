/**
 * Banner slice: the `SET_BANNER` echo, the dependency recheck, and the
 * banner sign-in/dismiss flows.
 */

import * as vscode from 'vscode';

import { AUTH_COMMANDS } from '@auth/constants';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { platform } from '@platform/platform';
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
    // Webview-initiated banner updates are echoed back to the active view so
    // the frontend banner state stays the single owner of visibility.
    [MAIN_VIEW_COMMANDS.SET_BANNER]: (m) => host.postToActiveView(m),
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
      view.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.SET_BANNER,
        banner: 'dependency',
        visible: missingTools.length > 0,
        ...(missingTools.length > 0 && {
          data: { missingTools: [...missingTools] },
        }),
      });
    },
    [MAIN_VIEW_COMMANDS.SIGN_IN_FROM_BANNER]: async () => {
      try {
        const authenticated = await vscode.commands.executeCommand<boolean>(
          AUTH_COMMANDS.SIGN_IN,
        );
        if (authenticated) {
          host.postToActiveView({
            command: MAIN_VIEW_COMMANDS.SET_BANNER,
            banner: 'login',
            visible: false,
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
      await platform().globalState.update(
        GlobalStateKey.LOGIN_BANNER_DISMISSED,
        true,
      );
    },
    [MAIN_VIEW_COMMANDS.DISMISS_ORCHESTRATOR_BANNER]: async () => {
      await platform().globalState.update(
        GlobalStateKey.ORCHESTRATOR_BANNER_DISMISSED,
        true,
      );
    },
  } satisfies Partial<MainViewInboundHandlerRegistry>;
}
