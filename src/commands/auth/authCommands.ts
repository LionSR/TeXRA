// Third-party imports
import * as vscode from 'vscode';

// Local imports - auth
import { AuthController } from '@frontend/auth/AuthController';

export function registerAuthCommands(
  context: vscode.ExtensionContext,
  controller: AuthController,
) {
  const signInCommand = vscode.commands.registerCommand(
    'texra.auth.signIn',
    async () => {
      await controller.signIn();
    },
  );

  const signOutCommand = vscode.commands.registerCommand(
    'texra.auth.signOut',
    async () => {
      await controller.signOut();
    },
  );

  const refreshCommand = vscode.commands.registerCommand(
    'texra.auth.refreshSession',
    async () => {
      await controller.refreshSession();
    },
  );

  context.subscriptions.push(signInCommand, signOutCommand, refreshCommand);

  return {
    signInCommand,
    signOutCommand,
    refreshCommand,
  };
}
