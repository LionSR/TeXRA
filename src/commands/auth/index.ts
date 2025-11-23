import * as vscode from 'vscode';
import { RemoteAgentLoader } from '@agent/remote/RemoteAgentLoader';
import * as authCommands from '@/auth/authCommands';
import { MAIN_VIEW_COMMANDS } from '@common/webview';

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
      'texra.auth.accountMenu',
      authCommands.showAccountMenu,
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

    // Set up the agent reference
    const agentRef = `remote://${selected.agentName}`;

    // Try to populate the agent selector automatically
    await vscode.commands.executeCommand('texra.mainView.focus');

    try {
      const webviewView = await vscode.commands.executeCommand<
        vscode.WebviewView | undefined
      >('texra.getWebviewView');

      if (webviewView) {
        // Send STATE_RESTORE message to set the agent selector value
        webviewView.webview.postMessage({
          command: MAIN_VIEW_COMMANDS.STATE_RESTORE,
          state: {
            workflowAgent: agentRef,
          },
        });
        void vscode.window.showInformationMessage(
          `Remote agent "${selected.agentName}" is now selected.`,
        );
      } else {
        // Fallback: copy to clipboard and show manual instruction
        await vscode.env.clipboard.writeText(agentRef);
        void vscode.window.showInformationMessage(
          `Could not auto-populate agent. Reference "${agentRef}" copied to clipboard - paste it in the agent selector.`,
        );
      }
    } catch (error) {
      // Fallback: copy to clipboard and show manual instruction
      await vscode.env.clipboard.writeText(agentRef);
      void vscode.window.showInformationMessage(
        `Could not auto-populate agent. Reference "${agentRef}" copied to clipboard - paste it in the agent selector.`,
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
  accountMenu: 'texra.auth.accountMenu',
  browseRemoteAgents: 'texra.remoteAgents.browse',
};
