// Third-party imports
import * as vscode from 'vscode';

// Local imports
import type { TeXRAAuthProvider } from '../../auth/authProvider';

/**
 * Command to login/authenticate user
 */
export async function loginCommand(
  authProvider: TeXRAAuthProvider,
): Promise<void> {
  try {
    // Check if already logged in
    const currentSession = await authProvider.getCurrentSession();
    if (currentSession) {
      const action = await vscode.window.showInformationMessage(
        `Already logged in as ${currentSession.account.label}. Do you want to add another account?`,
        'Add Account',
        'Cancel',
      );

      if (action !== 'Add Account') {
        return;
      }
    }

    // Create new session
    await authProvider.createSession([]);
  } catch (error) {
    // Error already handled in authProvider
    console.error('Login command error:', error);
  }
}
