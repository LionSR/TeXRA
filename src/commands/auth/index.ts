import * as vscode from 'vscode';
import { RemoteAgentLoader } from '@agent/remote/RemoteAgentLoader';
import { RemoteAgentRegistry } from '@agent/remote/RemoteAgentRegistry';
import { MAIN_VIEW_COMMANDS } from '@common/webview';
import * as authCommands from '@/auth/authCommands';

/**
 * Register authentication-related commands.
 */
export function registerAuthCommands(
  context: vscode.ExtensionContext,
): vscode.Disposable[] {
  // Initialize the profile view provider
  authCommands.initializeProfileViewProvider(context);

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
    // Check authentication status first
    const authStatus = await authCommands.getAuthStatus();

    // List available remote agents
    const agents = await RemoteAgentLoader.listRemoteAgents();

    if (agents.length === 0) {
      if (!authStatus.authenticated) {
        // User is not authenticated - prompt to sign in
        const signIn = 'Sign In';
        const choice = await vscode.window.showInformationMessage(
          'No remote agents available. Sign in to access remote agents from the researcher access program.',
          signIn,
        );

        if (choice === signIn) {
          await vscode.commands.executeCommand('texra.auth.signIn');
        }
      } else {
        // User is authenticated but no agents available - suggest contacting support
        const contactSupport = 'Contact Support';
        const choice = await vscode.window.showInformationMessage(
          'No remote agents available for your account tier. Please contact contact@texra.ai for assistance.',
          contactSupport,
        );

        if (choice === contactSupport) {
          await vscode.env.openExternal(
            vscode.Uri.parse('mailto:contact@texra.ai'),
          );
        }
      }
      return;
    }

    // Register remote agents so they can be executed
    const agentNames = agents.map((agent) => agent.name);
    RemoteAgentRegistry.registerMultiple(agentNames);

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

    // Use the clean agent name (no remote:// prefix needed anymore!)
    const agentName = selected.agentName;

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
            workflowAgent: agentName,
          },
        });
        void vscode.window.showInformationMessage(
          `Remote agent "${agentName}" is now selected.`,
        );
      } else {
        // Fallback: copy to clipboard and show manual instruction
        await vscode.env.clipboard.writeText(agentName);
        void vscode.window.showInformationMessage(
          `Could not auto-populate agent. Agent name "${agentName}" copied to clipboard - paste it in the agent selector.`,
        );
      }
    } catch (error) {
      // Fallback: copy to clipboard and show manual instruction
      await vscode.env.clipboard.writeText(agentName);
      void vscode.window.showInformationMessage(
        `Could not auto-populate agent. Agent name "${agentName}" copied to clipboard - paste it in the agent selector.`,
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
