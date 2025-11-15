// Third-party imports
import * as vscode from 'vscode';

// Local imports
import type { TeXRAAuthProvider } from '../../auth/authProvider';

/**
 * Command to show authentication status
 */
export async function authStatusCommand(
  authProvider: TeXRAAuthProvider,
): Promise<void> {
  try {
    const currentSession = await authProvider.getCurrentSession();
    const allSessions = await authProvider.getSessions();

    if (allSessions.length === 0) {
      vscode.window.showInformationMessage(
        'Not logged in. Use "TeXRA: Login" to authenticate.',
      );
      return;
    }

    // Build status message
    const statusLines: string[] = [];

    if (currentSession) {
      statusLines.push(
        `**Current Account:** ${currentSession.account.label}`,
      );
      if (currentSession.account.email) {
        statusLines.push(`**Email:** ${currentSession.account.email}`);
      }
      if (currentSession.scopes.length > 0) {
        statusLines.push(`**Scopes:** ${currentSession.scopes.join(', ')}`);
      }
    }

    if (allSessions.length > 1) {
      statusLines.push('');
      statusLines.push(`**Total Accounts:** ${allSessions.length}`);
      statusLines.push('');
      statusLines.push('**All Accounts:**');
      allSessions.forEach((session, index) => {
        const current = session.id === currentSession?.id ? ' (current)' : '';
        statusLines.push(
          `${index + 1}. ${session.account.label}${current}`,
        );
      });
    }

    statusLines.push('');
    statusLines.push(`**Strategy:** ${authProvider.getStrategyName()}`);

    // Show status in information message
    const markdown = new vscode.MarkdownString(statusLines.join('\n\n'));
    markdown.isTrusted = true;

    const action = await vscode.window.showInformationMessage(
      statusLines.join('\n'),
      'Switch Account',
      'Logout',
    );

    if (action === 'Switch Account') {
      await vscode.commands.executeCommand('texra.auth.switchAccount');
    } else if (action === 'Logout') {
      await vscode.commands.executeCommand('texra.auth.logout');
    }
  } catch (error) {
    console.error('Auth status command error:', error);
    vscode.window.showErrorMessage(
      `Failed to get status: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}
