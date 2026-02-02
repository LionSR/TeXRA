import * as vscode from 'vscode';
import {
  AUTH_COMMANDS,
  signIn,
  signOut,
  viewProfile,
} from '@/auth/authCommands';

/**
 * Register authentication-related commands.
 */
export function registerAuthCommands(
  context: vscode.ExtensionContext,
): vscode.Disposable[] {
  const disposables = [
    vscode.commands.registerCommand(AUTH_COMMANDS.SIGN_IN, signIn),
    vscode.commands.registerCommand(AUTH_COMMANDS.SIGN_OUT, signOut),
    vscode.commands.registerCommand(AUTH_COMMANDS.VIEW_PROFILE, viewProfile),
  ];

  context.subscriptions.push(...disposables);
  return disposables;
}

// Re-export AUTH_COMMANDS for external use
export { AUTH_COMMANDS, getAuthStatus } from '@/auth/authCommands';
