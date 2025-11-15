// Third-party imports
import * as vscode from 'vscode';

// Local imports
import type { TeXRAAuthProvider } from '../../auth/authProvider';

/**
 * Command to logout current user
 */
export async function logoutCommand(
  authProvider: TeXRAAuthProvider,
): Promise<void> {
  try {
    const currentSession = await authProvider.getCurrentSession();

    if (!currentSession) {
      vscode.window.showInformationMessage('Not logged in');
      return;
    }

    // Check if there are multiple sessions
    const allSessions = await authProvider.getSessions();

    if (allSessions.length > 1) {
      const action = await vscode.window.showQuickPick(
        [
          {
            label: `Logout ${currentSession.account.label}`,
            description: 'Logout current account',
            action: 'current',
          },
          {
            label: 'Logout all accounts',
            description: `Logout all ${allSessions.length} accounts`,
            action: 'all',
          },
        ],
        {
          placeHolder: 'Select logout option',
        },
      );

      if (!action) {
        return;
      }

      if (action.action === 'all') {
        await authProvider.logoutAll();
        return;
      }
    }

    // Logout current session
    await authProvider.removeSession(currentSession.id);
  } catch (error) {
    console.error('Logout command error:', error);
    vscode.window.showErrorMessage(
      `Logout failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}
