// Third-party imports
import * as vscode from 'vscode';

// Local imports
import {
  signIn as authSignIn,
  signOut as authSignOut,
} from '@commands/auth/authCommands';
import { handleCreateAgentWithAI as agentHandleCreateAgentWithAI } from '@commands/agent/agentCreatorCommands';
import { runExecuteCommand as agentRunExecuteCommand } from '@commands/agent/executeCommand';
import { downloadArXivSource as latexDownloadArXivSource } from '@commands/latex/arXivCommands';
import { launchSetupAssistant } from '@commands/setup/setupAssistantCommand';
import { createSampleProject as sysCreateSampleProject } from '@commands/system/sampleProjectCommands';
import { showImportOptions as sysShowImportOptions } from '@commands/system/mainViewCommands';
import {
  handleClean as fileHandleClean,
  handleCleanMultiple as fileHandleCleanMultiple,
  handleCleanSingle as fileHandleCleanSingle,
} from '@commands/housekeeping/cleanCommands';
import {
  handlePack as fileHandlePack,
  handlePackMultiple as fileHandlePackMultiple,
  handlePackSingle as fileHandlePackSingle,
} from '@commands/housekeeping/packCommands';
import {
  handleAcceptEdited as latexHandleAcceptEdited,
  handleCompare as latexHandleCompare,
} from '@commands/latex/compareCommands';
import {
  setApiKey as apiSetApiKey,
  removeApiKey as apiRemoveApiKey,
} from '@commands/api/apiKeyCommands';
import {
  handleIndentTeX,
  handleIndentCurrentTeX as latexIndentCurrentTeX,
  handleFixCompilation as latexFixCompilation,
  handleGetTeXCount as latexGetTeXCount,
} from '@commands/latex/latexCommands';
import {
  handleExtractTikzFigures as latexExtractTikzFigures,
  handleCompileTikzFigures as latexCompileTikzFigures,
} from '@commands/latex/figCommands';
import { cloneOverleafProject as gitCloneOverleafProject } from '@commands/git/gitCommands';
import {
  openProgressViewInTab as progressOpenInTab,
  showProgressView as progressShowProgressView,
} from '@commands/progress/progressViewCommands';
import { openGettingStarted as sysOpenGettingStarted } from '@commands/system/walkthroughCommands';
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import { runCleanBuild, runCleanOutput } from '@housekeeping/clean';
import type { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import type { SettingsViewProvider } from '@settingsView/SettingsViewProvider';
import { dispatchCommandFromRegistry } from '@shared/commands/registry';

// Local file imports
import {
  EXTENSION_COMMAND_HANDLERS,
  type ExtensionCommandActions,
} from './extensionCommandHandlers';

export function createExtensionCommandActions(
  context: vscode.ExtensionContext,
  settingsViewProvider: SettingsViewProvider,
  progressViewProvider: ProgressViewProvider,
): ExtensionCommandActions {
  const refreshAfterProviderKeyChange = (provider: string) =>
    settingsViewProvider.refreshAfterProviderKeyChange(provider);

  return {
    showSettings(tab, agentSubTab) {
      return settingsViewProvider.showSettingsView(tab, agentSubTab);
    },
    // New Session is the header's "+" (PRD 12.4): the New-task state into
    // view with the launcher's selections as they are.
    resetMainView: () => progressViewProvider.showLauncher(),
    cleanBuild: runCleanBuild,
    cleanOutput: runCleanOutput,
    pack: fileHandlePack,
    packSingle: fileHandlePackSingle,
    packMultiple: fileHandlePackMultiple,
    clean: fileHandleClean,
    cleanSingle: fileHandleCleanSingle,
    cleanMultiple: fileHandleCleanMultiple,
    compare: latexHandleCompare,
    acceptEdited: latexHandleAcceptEdited,
    indentTeX: handleIndentTeX,
    signIn: authSignIn,
    signInChatGpt: () => settingsViewProvider.signInSubscription('chatgpt'),
    signInGrok: () => settingsViewProvider.signInSubscription('grok'),
    signOut: authSignOut,
    runSetupAssistant: async () => {
      await launchSetupAssistant();
    },
    openGettingStarted: () => sysOpenGettingStarted(context.extension.id),
    createSampleProject: () => sysCreateSampleProject(context.extensionPath),
    downloadArXivSource: latexDownloadArXivSource,
    openProgressViewInTab: progressOpenInTab,
    async openDoc(page) {
      if (!page) return;
      await vscode.env.openExternal(
        vscode.Uri.parse(`https://texra.ai/guide/${page}.html`),
      );
    },
    indentCurrentTeX: latexIndentCurrentTeX,
    fixCompilation: latexFixCompilation,
    getTeXCount: latexGetTeXCount,
    extractTikzFigures: latexExtractTikzFigures,
    compileTikzFigures: latexCompileTikzFigures,
    cloneOverleafProject: gitCloneOverleafProject,
    removeApiKey: () => apiRemoveApiKey(refreshAfterProviderKeyChange),
    showImportOptions: sysShowImportOptions,
    toggleView: () => progressViewProvider.toggleDrawer(),
    showProgressView: progressShowProgressView,
    setApiKey: (provider) =>
      apiSetApiKey(refreshAfterProviderKeyChange, provider),
    createAgentWithAI: (category) =>
      agentHandleCreateAgentWithAI(context, category),
    // Without a configuration the command is the composer's accelerator
    // (Cmd+Alt+E): the launcher's instruction runs as its Send would.
    execute: (input) =>
      input === undefined
        ? Promise.resolve(progressViewProvider.submitLaunch())
        : agentRunExecuteCommand(input),
  };
}

/*
 * Duplicate-registration audit (#3787 follow-up):
 * Every command id in `EXTENSION_COMMAND_HANDLERS` has been verified to
 * have no stale `vscode.commands.registerCommand(...)` call elsewhere.
 * The remaining direct `registerCommand` call sites all register ids NOT
 * tagged `extensionRegistry` in `commandCatalog` — they're legitimate VS
 * Code-only handlers (git, file selection/opening, merge, and LaTeX tools).
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
      vscode.commands.registerCommand(id, (...rawArgs: unknown[]) =>
        dispatchCommandFromRegistry(
          id,
          EXTENSION_COMMAND_HANDLERS,
          actions,
          (failure) => {
            if (failure.kind === 'invalidArguments') {
              void showLoggedMessage(
                'ExtensionCommandRegistry',
                `Invalid arguments for command ${failure.id}: ${failure.error.message}`,
              );
              return;
            }
            console.error(
              `[extension] dispatch: unhandled command ${failure.id}`,
            );
          },
          ...rawArgs,
        ),
      ),
    );
  }
}
