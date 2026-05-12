// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { SettingsViewProvider } from '@settingsView/SettingsViewProvider';
import { SETTINGS_TAB } from '@shared/schemas/settingsViewMessages';

export const settingsViewCommands = {
  showSettingsView: 'texra.showSettingsView',
  showDashboard: 'texra.showDashboard',
  // Tab-specific commands
  showMemory: 'texra.showMemory',
  showHistory: 'texra.showAgentHistory',
  showModels: 'texra.showModels',
  showAgents: 'texra.showAgents',
  showTools: 'texra.showTools',
  showMultiAgent: 'texra.showMultiAgent',
  showGitSettings: 'texra.showGitSettings',
} as const;

let settingsViewProvider: SettingsViewProvider | null = null;

export function initializeSettingsViewProvider(
  context: vscode.ExtensionContext,
): SettingsViewProvider {
  if (!settingsViewProvider) {
    settingsViewProvider = new SettingsViewProvider(context);
  }
  return settingsViewProvider;
}

export async function showSettingsView(): Promise<void> {
  if (!settingsViewProvider) {
    void vscode.window.showErrorMessage(
      'Settings view not initialized. Please reload the extension.',
    );
    return;
  }
  await settingsViewProvider.showSettingsView();
}

/**
 * Most settings view-routing commands are now registered through the
 * shared command registry in `extensionCommandSurface.ts` (mirroring the
 * desktop's `DESKTOP_COMMAND_HANDLERS`). The remaining per-command
 * registration here covers `texra.showGitSettings`, which is not yet on
 * the desktop's menu surface and is also absent from `commandCatalog`,
 * so it stays VS Code-only via direct `registerCommand`.
 */
export function registerSettingsViewCommands(
  context: vscode.ExtensionContext,
): void {
  initializeSettingsViewProvider(context);

  context.subscriptions.push(
    vscode.commands.registerCommand(settingsViewCommands.showGitSettings, () =>
      settingsViewProvider?.showSettingsView(SETTINGS_TAB.GIT),
    ),
  );
}
