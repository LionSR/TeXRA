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
import { registerMainViewCommands } from '@commands/system/mainViewCommands';
import { registerGitCommands } from '@commands/git/gitCommands';
import { registerAgentReviewCommands } from '@commands/review/agentReviewCommands';

// Local imports - components
import { SettingsViewProvider } from '@settingsView/SettingsViewProvider';
import { ProgressViewProvider } from './progressView/ProgressViewProvider';

export function registerCommands(
  context: vscode.ExtensionContext,
  progressViewProvider: ProgressViewProvider,
): void {
  registerFileSelectionCommands(context);
  registerLatexdiffCommands(context);
  registerGitCommands(context);
  registerAgentReviewCommands(context);
  registerMergeCommands(context);
  const settingsViewProvider = new SettingsViewProvider(context);
  registerOpenFileCommands(context);
  registerMainViewCommands(context, progressViewProvider);

  // The shared registry owns every command whose handler map lives in
  // `extensionCommandSurface.ts`, dispatched the same way as the desktop
  // registry. The per-command registrations above stay separate because
  // their handlers carry VS Code-specific arguments (TextEditor, Range,
  // Uri, agent execution payloads) or capture VS Code state directly.
  registerExtensionCommandRegistry(
    context,
    createExtensionCommandActions(
      context,
      settingsViewProvider,
      progressViewProvider,
    ),
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ProgressViewProvider.viewType,
      progressViewProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      },
    ),
    // Registered here rather than through the shared registry because the
    // handler needs the provider instance.
    vscode.commands.registerCommand('texra.showMainView', () =>
      progressViewProvider.showLauncher(),
    ),
  );
}
