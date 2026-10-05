// Third-party imports
import * as vscode from 'vscode';

// Local imports - commands
import type { SessionHandle } from '@agent/runtime';
import {
  createExtensionCommandActions,
  registerExtensionCommandRegistry,
} from '@commands/extensionCommandSurface';
import type { SessionBackend } from '@texra/controllers/session/sessionBackend';

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
  backend: SessionBackend,
): void {
  const settingsViewProvider = new SettingsViewProvider(
    context,
    globalState,
    secrets,
    runtime,
    session,
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
      session,
      backend,
    ),
    runtime,
    session,
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
