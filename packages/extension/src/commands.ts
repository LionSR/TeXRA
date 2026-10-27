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
import type {
  ProcessRuntime,
  Session,
  PlatformSecrets,
  WorkspaceRoots,
} from '@texra-ai/harness';

export function registerCommands(
  context: vscode.ExtensionContext,
  progressViewProvider: ProgressViewProvider,
  secrets: PlatformSecrets,
  runtime: ProcessRuntime,
  roots: WorkspaceRoots,
  /** Where this window's runs run. */
  runSession: Session,
): SettingsViewProvider {
  const settingsViewProvider = new SettingsViewProvider(
    context,
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
  return settingsViewProvider;
}
