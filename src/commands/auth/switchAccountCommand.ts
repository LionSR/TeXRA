// Third-party imports
import * as vscode from 'vscode';

// Local imports
import type { TeXRAAuthProvider } from '../../auth/authProvider';

/**
 * Command to switch between accounts
 */
export async function switchAccountCommand(
  authProvider: TeXRAAuthProvider,
): Promise<void> {
  try {
    const sessions = await authProvider.getSessions();

    if (sessions.length === 0) {
      vscode.window.showInformationMessage('No accounts available. Please login first.');
      return;
    }

    if (sessions.length === 1) {
      vscode.window.showInformationMessage(
        `Only one account available: ${sessions[0].account.label}`,
      );
      return;
    }

    const currentSession = await authProvider.getCurrentSession();

    // Create quick pick items
    const items = sessions.map((session) => ({
      label: session.account.label,
      description: (session.account as any).email, // Email is optional in our extended type
      detail:
        session.id === currentSession?.id
          ? '$(check) Current account'
          : undefined,
      sessionId: session.id,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select account to switch to',
    });

    if (!selected) {
      return;
    }

    if (selected.sessionId === currentSession?.id) {
      vscode.window.showInformationMessage('Already using this account');
      return;
    }

    await authProvider.switchSession(selected.sessionId);
  } catch (error) {
    console.error('Switch account command error:', error);
    vscode.window.showErrorMessage(
      `Failed to switch account: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}
