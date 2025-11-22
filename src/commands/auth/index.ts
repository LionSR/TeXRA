import * as vscode from 'vscode';
import * as authCommands from '@/auth/authCommands';
import { RemoteAgentLoader } from '@agent/remote/RemoteAgentLoader';

/**
 * Register authentication-related commands.
 */
export function registerAuthCommands(
  context: vscode.ExtensionContext,
): vscode.Disposable[] {
  const disposables = [
    vscode.commands.registerCommand('texra.auth.signIn', authCommands.signIn),
    vscode.commands.registerCommand('texra.auth.signOut', authCommands.signOut),
    vscode.commands.registerCommand(
      'texra.auth.viewProfile',
      authCommands.viewProfile,
    ),
    vscode.commands.registerCommand(
      'texra.remoteAgents.browse',
      browseRemoteAgents,
    ),
  ];

  context.subscriptions.push(...disposables);
  return disposables;
}

/**
 * Command to browse and select remote agents.
 */
async function browseRemoteAgents(): Promise<void> {
  try {
    // List available remote agents
    const agents = await RemoteAgentLoader.listRemoteAgents();

    if (agents.length === 0) {
      const signIn = 'Sign In';
      const choice = await vscode.window.showInformationMessage(
        'No remote agents available. Sign in to access premium remote agents.',
        signIn,
      );

      if (choice === signIn) {
        await vscode.commands.executeCommand('texra.auth.signIn');
      }
      return;
    }

    // Create quick pick items
    const items = agents.map((agent) => ({
      label: `$(cloud) ${agent.name}`,
      description: agent.description,
      detail: `Visibility: ${agent.visibility} | Tags: ${agent.tags.join(', ') || 'none'}`,
      agentName: agent.name,
    }));

    // Show quick pick
    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a remote agent to use',
      matchOnDescription: true,
      matchOnDetail: true,
    });

    if (!selected) {
      return;
    }

    // Copy the remote agent reference to clipboard for easy use
    const agentRef = `remote://${selected.agentName}`;
    await vscode.env.clipboard.writeText(agentRef);

    const useNow = 'Use Now';
    const action = await vscode.window.showInformationMessage(
      `Remote agent reference "${agentRef}" copied to clipboard. You can paste it in the agent selector.`,
      useNow,
    );

    if (action === useNow) {
      // Open main view and suggest using this agent
      // This is a best-effort action - the user can manually paste the reference
      await vscode.commands.executeCommand('texra.mainView.focus');
      void vscode.window.showInformationMessage(
        `Paste "${agentRef}" in the agent selector to use this remote agent.`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(
      `Failed to browse remote agents: ${message}`,
    );
  }
}

export const authCommandsList = {
  signIn: 'texra.auth.signIn',
  signOut: 'texra.auth.signOut',
  viewProfile: 'texra.auth.viewProfile',
  browseRemoteAgents: 'texra.remoteAgents.browse',
};
