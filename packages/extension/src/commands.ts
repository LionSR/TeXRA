// Third-party imports
import * as vscode from 'vscode';

// Local imports - commands
import type { SessionHandle } from '@agent/runtime';
import {
  createExtensionCommandActions,
  registerExtensionCommandRegistry,
} from '@commands/extensionCommandSurface';
import { registerOpenFileCommands } from '@commands/files/openFileCommands';
import { registerLatexdiffCommands } from '@commands/latex/latexdiffCommands';
import { registerMergeCommands } from '@commands/agent/mergeCommands';
import { registerMainViewCommands } from '@commands/system/mainViewCommands';
import { registerGitCommands } from '@commands/git/gitCommands';
import { registerAgentReviewCommands } from '@commands/review/agentReviewCommands';

// Local imports - components
import type { StateStore } from '@platform/interfaces';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import { SettingsViewProvider } from '@settingsView/SettingsViewProvider';
import { ProgressViewProvider } from './progressView/ProgressViewProvider';

export function registerCommands(
  context: vscode.ExtensionContext,
  globalState: StateStore,
  progressViewProvider: ProgressViewProvider,
  secrets: PlatformSecrets,
  runtime: ProcessRuntime,
  session: SessionHandle,
): void {
  registerLatexdiffCommands(context, runtime, session);
  registerGitCommands(context, session);
  registerAgentReviewCommands(context, runtime, session);
  registerMergeCommands(context, globalState, runtime);
  const settingsViewProvider = new SettingsViewProvider(
    context,
    globalState,
    secrets,
    runtime,
    session,
  );
  registerOpenFileCommands(context, runtime, session);
  registerMainViewCommands(context, progressViewProvider, runtime);

  // The shared registry owns every command whose handler map lives in
  // `extensionCommandSurface.ts`, dispatched the same way as the desktop
  // registry. The per-command registrations above stay separate because
  // their handlers carry VS Code-specific arguments (TextEditor, Range,
  // Uri, agent run payloads) or capture VS Code state directly.
  registerExtensionCommandRegistry(
    context,
    createExtensionCommandActions(
      context,
      globalState,
      settingsViewProvider,
      progressViewProvider,
      secrets,
      runtime,
      session,
    ),
    runtime,
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
      runtime.runPromise(progressViewProvider.showLauncher()),
    ),
  );
}
