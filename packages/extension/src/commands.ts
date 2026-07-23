// Third-party imports
import * as vscode from 'vscode';

// Local imports - commands
import {
  registerFileSelectionCommands,
  registerOpenFileCommands,
} from '@commands/files';
import { registerLatexdiffCommands } from '@commands/latex';
import {
  registerMergeCommands,
  registerFollowUpCommand,
  registerResumeAgentCommand,
} from '@commands/agent';
import { registerMainViewCommands } from '@commands/system';
import { registerStateRestoreCommand } from '@commands/taskFormState';
import {
  createExtensionCommandActions,
  registerExtensionCommandRegistry,
} from '@commands/extensionCommandSurface';
import { registerGitCommands } from '@commands/git/gitCommands';
import { registerAgentReviewCommands } from '@commands/review/agentReviewCommands';

// Local imports - components
import { SettingsViewProvider } from '@settingsView/SettingsViewProvider';
import { MainViewProvider } from './MainViewProvider';

export function registerCommands(context: vscode.ExtensionContext) {
  registerFileSelectionCommands(context);
  registerLatexdiffCommands(context);
  registerGitCommands(context);
  registerAgentReviewCommands(context);
  registerMergeCommands(context);
  registerStateRestoreCommand(context);
  const settingsViewProvider = new SettingsViewProvider(context);
  registerFollowUpCommand(context);
  registerResumeAgentCommand(context);
  registerOpenFileCommands(context);
  registerMainViewCommands(context);

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
  // toggleView, showProgressView, setApiKey, createAgentWithAI, execute),
  // and the typed pack/clean/compare file-operation families
  // — all alongside the original settings/main-view routes via the same
  // dispatch path as the desktop registry. See
  // `extensionCommandSurface.ts` for the handler map.
  //
  // FOLLOW_UP (#3781): the remaining per-command registrations carry
  // VS Code-specific arguments (TextEditor, Range, Uri, agent execution
  // payloads). Commands whose handlers capture VS Code state directly
  // (e.g. `vscode.window.activeTextEditor`) stay on per-command registration.
  // Host-exclusive commands like `texra.showGitSettings` follow the same
  // `Exclude<>` pattern desktop already uses.
  registerExtensionCommandRegistry(
    context,
    createExtensionCommandActions(context, settingsViewProvider),
  );

  const mainViewProvider = new MainViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'texra.mainView',
      mainViewProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      },
    ),
  );

  return { mainViewProvider, settingsViewProvider };
}
