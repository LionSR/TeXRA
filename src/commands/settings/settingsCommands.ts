// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { SettingsViewProvider } from '@settingsView/SettingsViewProvider';
import { SETTINGS_TAB } from '@shared/schemas/settingsViewMessages';
import type { AgentCategory } from '@shared/schemas/agent';

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

export function registerSettingsViewCommands(
  context: vscode.ExtensionContext,
): void {
  initializeSettingsViewProvider(context);

  context.subscriptions.push(
    // Primary commands
    vscode.commands.registerCommand(settingsViewCommands.showSettingsView, () =>
      settingsViewProvider?.showSettingsView(),
    ),
    vscode.commands.registerCommand(settingsViewCommands.showDashboard, () =>
      settingsViewProvider?.showSettingsView(),
    ),
    // Tab-specific commands
    vscode.commands.registerCommand(settingsViewCommands.showMemory, () =>
      settingsViewProvider?.showSettingsView(SETTINGS_TAB.MEMORY),
    ),
    vscode.commands.registerCommand(settingsViewCommands.showHistory, () =>
      settingsViewProvider?.showSettingsView(SETTINGS_TAB.HISTORY),
    ),
    vscode.commands.registerCommand(settingsViewCommands.showModels, () =>
      settingsViewProvider?.showSettingsView(SETTINGS_TAB.MODELS),
    ),
    vscode.commands.registerCommand(
      settingsViewCommands.showAgents,
      (subTab?: AgentCategory) =>
        settingsViewProvider?.showSettingsView(SETTINGS_TAB.AGENTS, subTab),
    ),
    vscode.commands.registerCommand(settingsViewCommands.showTools, () =>
      settingsViewProvider?.showSettingsView(SETTINGS_TAB.TOOLS),
    ),
    vscode.commands.registerCommand(settingsViewCommands.showMultiAgent, () =>
      settingsViewProvider?.showSettingsView(SETTINGS_TAB.MULTI_AGENT),
    ),
    vscode.commands.registerCommand(settingsViewCommands.showGitSettings, () =>
      settingsViewProvider?.showSettingsView(SETTINGS_TAB.GIT),
    ),
  );
}
