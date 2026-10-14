// Third-party imports
import * as vscode from 'vscode';

// Local imports - commands
import {
  createExtensionCommandActions,
  registerExtensionCommandRegistry,
} from '@commands/extensionCommandSurface';

// Local imports - components
import { SettingsViewProvider } from '@settingsView/SettingsViewProvider';
import { ProgressViewProvider } from './progressView/ProgressViewProvider';
import type { ProcessRuntime, Session } from '@texra-ai/harness';
import type { PlatformSecrets, StateStore } from '@texra-ai/harness';
import type { WorkspaceRoots } from '@texra-ai/harness';

export function registerCommands(
  context: vscode.ExtensionContext,
  globalState: StateStore,
  progressViewProvider: ProgressViewProvider,
  secrets: PlatformSecrets,
  runtime: ProcessRuntime,
  roots: WorkspaceRoots,
  /** Where this window's runs run. */
  runSession: Session,
): void {
  const settingsViewProvider = new SettingsViewProvider(
    context,
    globalState,
    secrets,
    runtime,
    roots,
    progressViewProvider,
  );

  // The shared registry, dispatched the same way as the desktop registry.
  registerExtensionCommandRegistry(
    context,
    createExtensionCommandActions(
      context,
      settingsViewProvider,
      progressViewProvider,
      secrets,
      roots,
      runSession,
    ),
    runtime,
    roots,
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
  );
}
