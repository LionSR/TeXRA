// Third-party imports
import * as vscode from 'vscode';

// Local imports
import type { TeXRAAuthProvider } from './authProvider';

/**
 * Status bar item showing current authentication status
 */
export class AuthStatusBar {
  private statusBarItem: vscode.StatusBarItem;
  private authProvider: TeXRAAuthProvider;

  constructor(authProvider: TeXRAAuthProvider) {
    this.authProvider = authProvider;

    // Create status bar item
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100, // Priority (higher = more to the left)
    );

    this.statusBarItem.command = 'texra.auth.status';

    // Listen for session changes
    authProvider.onDidChangeSessions(() => {
      this.update();
    });

    // Initial update
    this.update();
  }

  /**
   * Update status bar display
   */
  public async update(): Promise<void> {
    try {
      const currentSession = await this.authProvider.getCurrentSession();

      if (!currentSession) {
        // Not logged in
        this.statusBarItem.text = '$(account) Not logged in';
        this.statusBarItem.tooltip = 'Click to login to TeXRA';
        this.statusBarItem.backgroundColor = undefined;
      } else {
        // Logged in
        const accountName = currentSession.account.label;
        this.statusBarItem.text = `$(account) ${accountName}`;

        // Build tooltip
        const tooltipLines = [
          `Logged in as: ${accountName}`,
        ];

        if (currentSession.account.email) {
          tooltipLines.push(`Email: ${currentSession.account.email}`);
        }

        const allSessions = await this.authProvider.getSessions();
        if (allSessions.length > 1) {
          tooltipLines.push(`(${allSessions.length} accounts)`);
        }

        tooltipLines.push('');
        tooltipLines.push('Click to view status');

        this.statusBarItem.tooltip = tooltipLines.join('\n');
        this.statusBarItem.backgroundColor = undefined;
      }

      this.show();
    } catch (error) {
      console.error('Error updating auth status bar:', error);
      this.statusBarItem.text = '$(account) Auth error';
      this.statusBarItem.tooltip = 'Error getting authentication status';
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.errorBackground',
      );
      this.show();
    }
  }

  /**
   * Show status bar item
   */
  public show(): void {
    this.statusBarItem.show();
  }

  /**
   * Hide status bar item
   */
  public hide(): void {
    this.statusBarItem.hide();
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this.statusBarItem.dispose();
  }
}
