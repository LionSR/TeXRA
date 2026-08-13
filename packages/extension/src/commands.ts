// Third-party imports
import * as vscode from 'vscode';

// Local imports - commands
import {
  createExtensionCommandActions,
  registerExtensionCommandRegistry,
} from '@commands/extensionCommandSurface';
import { registerFileSelectionCommands } from '@commands/files/fileSelectionCommands';
import { registerOpenFileCommands } from '@commands/files/openFileCommands';
import { registerLatexdiffCommands } from '@commands/latex/latexdiffCommands';
import { registerMergeCommands } from '@commands/agent/mergeCommands';
import { registerFollowUpCommand } from '@commands/agent/followUpCommand';
import { registerResumeAgentCommand } from '@commands/agent/resumeCommand';
import { registerMainViewCommands } from '@commands/system/mainViewCommands';
import { registerStateRestoreCommand } from '@commands/taskFormState/stateRestoreCommand';
import { registerGitCommands } from '@commands/git/gitCommands';
import { registerAgentReviewCommands } from '@commands/review/agentReviewCommands';

// Local imports - components
import { SettingsViewProvider } from '@settingsView/SettingsViewProvider';
import { MainViewProvider } from './webview/MainViewProvider';

export function registerCommands(
  context: vscode.ExtensionContext,
): MainViewProvider {
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

  // The shared registry owns every command whose handler map lives in
  // `extensionCommandSurface.ts`, dispatched the same way as the desktop
  // registry. The per-command registrations above stay separate because
  // their handlers carry VS Code-specific arguments (TextEditor, Range,
  // Uri, agent execution payloads) or capture VS Code state directly.
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
    // Registered here rather than through the shared registry because the
    // handlers need the `MainViewProvider` instance created just above.
    vscode.commands.registerCommand('texra.showMainView', () =>
      mainViewProvider.showInSidebar(),
    ),
    vscode.commands.registerCommand('texra.getWebviewView', () =>
      mainViewProvider.getMainModeView(),
    ),
  );

  return mainViewProvider;
}
