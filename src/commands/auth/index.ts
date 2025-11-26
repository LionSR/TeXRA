import * as vscode from 'vscode';
import {
  loadAndRegisterRemoteAgents,
  selectAgentInMainView,
} from '@agent/remote/remoteAgentUtils';
import * as authCommands from '@/auth/authCommands';
import { AUTH_COMMANDS } from '@/auth/authCommands';

/**
 * Register authentication-related commands.
 */
export function registerAuthCommands(
  context: vscode.ExtensionContext,
): vscode.Disposable[] {
  // Initialize the profile view provider
  authCommands.initializeProfileViewProvider(context);

  const disposables = [
    vscode.commands.registerCommand(AUTH_COMMANDS.SIGN_IN, authCommands.signIn),
    vscode.commands.registerCommand(
      AUTH_COMMANDS.SIGN_OUT,
      authCommands.signOut,
    ),
    vscode.commands.registerCommand(
      AUTH_COMMANDS.VIEW_PROFILE,
      authCommands.viewProfile,
    ),
    vscode.commands.registerCommand(
      AUTH_COMMANDS.ACCOUNT_MENU,
      authCommands.showAccountMenu,
    ),
    vscode.commands.registerCommand(
      AUTH_COMMANDS.BROWSE_REMOTE_AGENTS,
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

    // Use shared utility to load and register agents
    const { agents } = await loadAndRegisterRemoteAgents();

    if (agents.length === 0) {
      if (!authStatus.authenticated) {
        // User is not authenticated - prompt to sign in
        const signIn = 'Sign In';
        const choice = await vscode.window.showInformationMessage(
          'No remote agents available. Sign in to access remote agents from the researcher access program.',
          signIn,
        );

        if (choice === signIn) {
          await vscode.commands.executeCommand(AUTH_COMMANDS.SIGN_IN);
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

    // Use shared utility for agent selection with clipboard fallback
    await selectAgentInMainView(selected.agentName, {
      showSuccessMessage: true,
      copyToClipboardOnFailure: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(
      `Failed to browse remote agents: ${message}`,
    );
  }
}

// Re-export AUTH_COMMANDS for external use
export { AUTH_COMMANDS } from '@/auth/authCommands';
