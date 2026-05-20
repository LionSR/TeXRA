// Third-party imports
import * as vscode from 'vscode';

// Local imports - commands
import {
  registerFileSelectionCommands,
  registerOpenFileCommands,
} from '@commands/files';
import {
  registerLatexdiffCommands,
  registerLatexCommands,
  registerImageCommands,
  registerFigureCommands,
  registerLinterCommands,
  registerCompareCommands,
} from '@commands/latex';
import {
  registerPackCommands,
  registerCleanCommands,
} from '@commands/housekeeping';
import {
  registerMergeCommands,
  registerExecuteCommand,
  registerFollowUpCommand,
  registerResumeAgentCommand,
  registerAgentTeamCommands,
} from '@commands/agent';
import {
  registerXmlCommands,
  registerYamlCommands,
  registerTextEditorCommands,
  registerSettingsCommands,
  registerMainViewCommands,
} from '@commands/system';
import { registerStateRestoreCommand } from '@commands/history';
import {
  registerSettingsViewCommands,
  initializeSettingsViewProvider,
} from '@commands/settings';
import { registerAuthCommands } from '@commands/auth';
import {
  createExtensionCommandActions,
  registerExtensionCommandRegistry,
} from '@commands/extensionCommandSurface';
import { registerApiKeyCommands } from '@commands/api/apiKeyCommands';
import { registerGitCommands } from '@commands/git/gitCommands';
// Local file imports
import { MainViewProvider } from './MainViewProvider';

let mainViewProviderInstance: MainViewProvider | null = null;

export function getMainViewProvider(): MainViewProvider | null {
  return mainViewProviderInstance;
}

export function registerCommands(context: vscode.ExtensionContext): void {
  registerFileSelectionCommands(context);
  registerLatexdiffCommands(context);
  registerGitCommands(context);
  registerPackCommands(context);
  registerCleanCommands(context);
  registerMergeCommands(context);
  registerAgentTeamCommands(context);
  registerExecuteCommand(context);
  registerLatexCommands(context);
  registerImageCommands(context);
  registerFigureCommands(context);
  registerXmlCommands(context);
  registerYamlCommands(context);
  registerApiKeyCommands(context);
  registerAuthCommands(context);
  registerStateRestoreCommand(context);
  registerTextEditorCommands(context);
  registerLinterCommands(context);
  registerSettingsViewCommands(context);
  registerCompareCommands(context);
  registerFollowUpCommand(context);
  registerResumeAgentCommand(context);
  registerOpenFileCommands(context);
  registerMainViewCommands(context);
  registerSettingsCommands(context);

  // The shared registry now owns the no-arg housekeeping (cleanOutput,
  // cleanBuild, indentTeX), auth (signIn/signOut/viewProfile), system
  // entry points (runSetupAssistant, openGettingStarted, createSampleProject,
  // testConnection, testAgentLoading, loadSpecificAgent, openProgressViewInTab,
  // downloadArXivSource), batch-2 host-context entry points (parseXml,
  // parseYaml, testTextEditor, indentCurrentTeX,
  // applyReplacements, fixCompilation, getTeXCount, countPdfPages,
  // showLinterMessages, countLinterMessages, extractFigurePaths), the
  // typed-arg handlers for openDoc/stopAgent/compactResponse, and the
  // batch-4 (#3781) follow-ups (removeApiKey, showImportOptions,
  // toggleView, showProgressView, setApiKey, createAgentWithAI, execute)
  // — all alongside the original settings/main-view routes via the same
  // dispatch path as the desktop registry. See
  // `extensionCommandSurface.ts` for the handler map.
  //
  // FOLLOW_UP (#3781): the remaining per-command registrations carry
  // VS Code-specific arguments (TextEditor, Range, Uri, FileLocation,
  // pack/clean configs, agent execution payloads). Migrating those needs
  // either: (a) the `definedHandler` typed-args path in
  // `@shared/commands/registry` plus per-command Zod arg schemas, or
  // (b) staying on per-command registration where the handler captures
  // VS Code state directly (e.g. `vscode.window.activeTextEditor`).
  // Host-exclusive commands like `texra.showGitSettings` follow the same
  // `Exclude<>` pattern desktop already uses.
  const settingsViewProvider = initializeSettingsViewProvider(context);
  registerExtensionCommandRegistry(
    context,
    createExtensionCommandActions(context, settingsViewProvider),
  );

  mainViewProviderInstance = new MainViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'texra.mainView',
      mainViewProviderInstance,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      },
    ),
  );
}

export { linterCommands, arXivCommands } from '@commands/latex';
export { runExecuteCommand, agentCreatorCommands } from '@commands/agent';
export {
  xmlCommands,
  yamlCommands,
  helpCommands,
  settingsCommands,
  mainViewCommands,
  sampleProjectCommands,
} from '@commands/system';
export { apiKeyCommands } from '@commands/api/apiKeyCommands';
export { historyCommands } from '@commands/history';
export { settingsViewCommands } from '@commands/settings';
