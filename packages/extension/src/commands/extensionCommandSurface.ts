// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { signIn as authSignIn, signOut as authSignOut } from '@commands/auth';
import {
  stopAgent as agentStopAgent,
  compactResponse as agentCompactResponse,
  handleCreateAgentWithAI as agentHandleCreateAgentWithAI,
  runExecuteCommand as agentRunExecuteCommand,
} from '@commands/agent';
import { downloadArXivSource as latexDownloadArXivSource } from '@commands/latex';
import { launchSetupAssistant } from '@commands/setup';
import {
  createSampleProject as sysCreateSampleProject,
  handleTestConnection as sysHandleTestConnection,
  handleTestAgentLoading as sysHandleTestAgentLoading,
  handleLoadSpecificAgent as sysHandleLoadSpecificAgent,
  showImportOptions as sysShowImportOptions,
} from '@commands/system';
import {
  setApiKey as apiSetApiKey,
  removeApiKey as apiRemoveApiKey,
} from '@commands/api/apiKeyCommands';
import {
  handleIndentTeX,
  handleIndentCurrentTeX as latexIndentCurrentTeX,
  handleApplyReplacements as latexApplyReplacements,
  handleFixCompilation as latexFixCompilation,
  handleGetTeXCount as latexGetTeXCount,
} from '@commands/latex/latexCommands';
import {
  handleCountPdfPages as latexCountPdfPages,
  handleEncodeImageToBase64 as latexEncodeImageToBase64,
  handleConvertPdfToImages as latexConvertPdfToImages,
} from '@commands/latex/imageCommands';
import {
  handleShowLinterMessages as latexShowLinterMessages,
  handleCountLinterMessages as latexCountLinterMessages,
} from '@commands/latex/linterCommands';
import {
  handleExtractFigurePaths as latexExtractFigurePaths,
  handleExtractTikzFigures as latexExtractTikzFigures,
  handleCompileTikzFigures as latexCompileTikzFigures,
} from '@commands/latex/figCommands';
import { cloneOverleafProject as gitCloneOverleafProject } from '@commands/git/gitCommands';
import {
  openProgressViewInTab as progressOpenInTab,
  showProgressView as progressShowProgressView,
} from '@commands/progress/progressViewCommands';
import { openDoc as sysOpenDoc } from '@commands/system/helpCommands';
import { openGettingStarted as sysOpenGettingStarted } from '@commands/system/walkthroughCommands';
import { handleParseXml as sysParseXml } from '@commands/system/xmlCommands';
import { handleParseYaml as sysParseYaml } from '@commands/system/yamlCommands';
import { handleTestTextEditor as sysTestTextEditor } from '@commands/system/textEditorCommands';
import { SIDEBAR_VIEWS, getActiveSidebarView } from '@common/webview';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { getMainWebview } from '@frontend/system/commandUtils';
import { signInWithChatGptSubscription } from '@frontend/auth/codexSubscriptionSignIn';
import { runCleanBuild, runCleanOutput } from '@housekeeping';
import type { SettingsViewProvider } from '@settingsView/SettingsViewProvider';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type { AgentCategory } from '@shared/schemas/agent';
import { dispatchCommandFromRegistry } from '@shared/commands/registry';
import { SETTINGS_QUERY } from '@utils/config';

// Local file imports
import {
  EXTENSION_COMMAND_HANDLERS,
  EXTENSION_PARAMETERIZED_HANDLERS,
  type ExtensionCommandActions,
} from './extensionCommandHandlers';

const RESET_CHANNEL = 'mainViewCommands';
const CHATGPT_SIGN_IN_CHANNEL = 'ChatGptSubscription';
const AUTH_CHANNEL = 'authCommands';

export function createExtensionCommandActions(
  context: vscode.ExtensionContext,
  settingsViewProvider: SettingsViewProvider,
): ExtensionCommandActions {
  return {
    showSettings(tabIndex, agentSubTab) {
      return settingsViewProvider.showSettingsView(tabIndex, agentSubTab);
    },
    async resetMainView() {
      const webviewView = await getMainWebview(RESET_CHANNEL);
      if (!webviewView) {
        void vscode.window.showWarningMessage(
          'Main view is not available. Please ensure the TeXRA view is open.',
        );
        return;
      }
      webviewView.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.STATE_RESTORE,
        state: {},
        isResetOperation: true,
      });
    },
    openWorkbenchSettings() {
      return vscode.commands.executeCommand(
        'workbench.action.openSettings',
        SETTINGS_QUERY.EXTENSION,
      );
    },
    cleanBuild: runCleanBuild,
    cleanOutput: runCleanOutput,
    indentTeX: handleIndentTeX,
    signIn: authSignIn,
    async signInChatGpt() {
      const signedIn = await signInWithChatGptSubscription(
        CHATGPT_SIGN_IN_CHANNEL,
      );
      await Promise.all([
        vscode.commands.executeCommand('texra.refreshApiKeyStatus'),
        vscode.commands.executeCommand('texra.refreshAllOptions'),
      ]);
      return signedIn;
    },
    signOut: authSignOut,
    async viewProfile() {
      try {
        await settingsViewProvider.showSettingsView();
      } catch (error) {
        void showLoggedErrorMessage(
          AUTH_CHANNEL,
          'Failed to load profile',
          error,
        );
      }
    },
    runSetupAssistant: async () => {
      await launchSetupAssistant();
    },
    openGettingStarted: () => sysOpenGettingStarted(context.extension.id),
    createSampleProject: () => sysCreateSampleProject(context.extensionPath),
    downloadArXivSource: latexDownloadArXivSource,
    testConnection: sysHandleTestConnection,
    testAgentLoading: sysHandleTestAgentLoading,
    loadSpecificAgent: sysHandleLoadSpecificAgent,
    openProgressViewInTab: progressOpenInTab,
    openDoc: sysOpenDoc,
    stopAgent: agentStopAgent,
    compactResponse: agentCompactResponse,
    parseXml: sysParseXml,
    parseYaml: sysParseYaml,
    testTextEditor: sysTestTextEditor,
    indentCurrentTeX: latexIndentCurrentTeX,
    applyReplacements: latexApplyReplacements,
    fixCompilation: latexFixCompilation,
    getTeXCount: latexGetTeXCount,
    countPdfPages: latexCountPdfPages,
    showLinterMessages: latexShowLinterMessages,
    countLinterMessages: latexCountLinterMessages,
    extractFigurePaths: latexExtractFigurePaths,
    encodeImageToBase64: latexEncodeImageToBase64,
    convertPdfToImages: latexConvertPdfToImages,
    extractTikzFigures: latexExtractTikzFigures,
    compileTikzFigures: latexCompileTikzFigures,
    cloneOverleafProject: () => gitCloneOverleafProject(context),
    removeApiKey: apiRemoveApiKey,
    showImportOptions: sysShowImportOptions,
    async toggleView() {
      const target =
        getActiveSidebarView() === SIDEBAR_VIEWS.MAIN
          ? 'texra.showProgressView'
          : 'texra.showMainView';
      await vscode.commands.executeCommand(target);
    },
    showProgressView: progressShowProgressView,
    setApiKey: apiSetApiKey,
    createAgentWithAI: (category) =>
      agentHandleCreateAgentWithAI(context, category),
    execute: agentRunExecuteCommand,
  };
}

/*
 * Duplicate-registration audit (#3787 follow-up):
 * Every command id in `EXTENSION_COMMAND_HANDLERS` +
 * `EXTENSION_PARAMETERIZED_HANDLERS` has been verified to have no stale
 * `vscode.commands.registerCommand(...)` call elsewhere. The remaining
 * legacy `registerCommand` call sites all register ids NOT tagged
 * `extensionRegistry` in `commandCatalog` — they're legitimate VS
 * Code-only handlers (file ops, git, latex tools, pack/clean variants).
 */

/**
 * Register every command in the shared registry against `vscode.commands`,
 * routing each invocation through `dispatchCommandFromRegistry` so the
 * dispatch path is identical to the desktop's. The registered callback
 * returns the dispatch result (a `boolean | Promise<boolean>`) so VS Code
 * forwards the underlying promise to `executeCommand` callers — async
 * rejections propagate instead of being swallowed (the bug fixed by
 * #3782).
 */
export function registerExtensionCommandRegistry(
  context: vscode.ExtensionContext,
  actions: ExtensionCommandActions,
): void {
  for (const id of Object.keys(EXTENSION_COMMAND_HANDLERS) as ReadonlyArray<
    keyof typeof EXTENSION_COMMAND_HANDLERS
  >) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, (rawArg?: unknown) =>
        dispatchCommandFromRegistry(
          id,
          EXTENSION_COMMAND_HANDLERS,
          actions,
          (unhandledId) => {
            console.error(
              `[extension] dispatch: unhandled command ${unhandledId}`,
            );
          },
          rawArg,
        ),
      ),
    );
  }

  for (const id of Object.keys(
    EXTENSION_PARAMETERIZED_HANDLERS,
  ) as ReadonlyArray<keyof typeof EXTENSION_PARAMETERIZED_HANDLERS>) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, (arg?: AgentCategory) =>
        EXTENSION_PARAMETERIZED_HANDLERS[id](actions, arg),
      ),
    );
  }
}
