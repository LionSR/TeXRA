import * as vscode from 'vscode';
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
  ];

  context.subscriptions.push(...disposables);
  return disposables;
}

// Re-export AUTH_COMMANDS for external use
export { AUTH_COMMANDS } from '@/auth/authCommands';
