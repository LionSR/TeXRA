// Third-party imports
import * as vscode from 'vscode';

// Local imports
import type { TeXRAAuthProvider } from '../../auth/authProvider';
import {
  loginCommand,
  logoutCommand,
  switchAccountCommand,
  authStatusCommand,
} from './index';

/**
 * Register authentication-related commands
 */
export function registerAuthCommands(
  context: vscode.ExtensionContext,
  authProvider: TeXRAAuthProvider,
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // Login command
  disposables.push(
    vscode.commands.registerCommand('texra.auth.login', async () => {
      await loginCommand(authProvider);
    }),
  );

  // Logout command
  disposables.push(
    vscode.commands.registerCommand('texra.auth.logout', async () => {
      await logoutCommand(authProvider);
    }),
  );

  // Switch account command
  disposables.push(
    vscode.commands.registerCommand('texra.auth.switchAccount', async () => {
      await switchAccountCommand(authProvider);
    }),
  );

  // Show status command
  disposables.push(
    vscode.commands.registerCommand('texra.auth.status', async () => {
      await authStatusCommand(authProvider);
    }),
  );

  return disposables;
}
