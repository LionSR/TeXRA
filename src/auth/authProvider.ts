// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { SessionManager } from './sessionManager';
import { LocalStrategy } from './strategies/localStrategy';
import type { AuthSession, AuthStrategy } from './types';
import { AuthError, AuthErrorCode } from './types';

/**
 * TeXRA Authentication Provider
 * Implements VS Code's AuthenticationProvider interface
 */
export class TeXRAAuthProvider implements vscode.AuthenticationProvider {
  /**
   * Provider ID (must match package.json)
   */
  public static readonly PROVIDER_ID = 'texra';

  /**
   * Provider label shown in VS Code UI
   */
  public static readonly PROVIDER_LABEL = 'TeXRA';

  /**
   * Event emitter for session changes
   */
  private readonly _onDidChangeSessions =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();

  /**
   * Event fired when sessions change
   */
  public readonly onDidChangeSessions = this._onDidChangeSessions.event;

  /**
   * Authentication strategy to use
   */
  private strategy: AuthStrategy;

  constructor() {
    // Default to local strategy
    // Can be extended to support multiple strategies based on configuration
    this.strategy = new LocalStrategy();
  }

  /**
   * Get all active sessions
   * Called by VS Code to retrieve existing authentication sessions
   */
  public async getSessions(
    scopes?: readonly string[],
    options?: vscode.AuthenticationProviderSessionOptions,
  ): Promise<vscode.AuthenticationSession[]> {
    try {
      const sessions = await SessionManager.getSessions();

      // Filter by scopes if provided
      if (scopes && scopes.length > 0) {
        return sessions.filter((session) =>
          scopes.every((scope) => session.scopes.includes(scope)),
        );
      }

      return sessions;
    } catch (error) {
      console.error('Error getting sessions:', error);
      return [];
    }
  }

  /**
   * Create a new authentication session
   * Called when user initiates login
   */
  public async createSession(
    scopes: readonly string[],
  ): Promise<AuthSession> {
    try {
      // Use strategy to authenticate
      const session = await this.strategy.authenticate([...scopes]);

      // Store session
      const storedSession = await SessionManager.createSession(
        session.account.id,
        session.account.label,
        session.accessToken,
        {
          email: session.account.email,
          scopes: [...scopes],
        },
      );

      // Notify VS Code of session change
      this._onDidChangeSessions.fire({
        added: [storedSession],
        removed: [],
        changed: [],
      });

      vscode.window.showInformationMessage(
        `Successfully logged in as ${session.account.label}`,
      );

      return storedSession;
    } catch (error) {
      if (error instanceof AuthError) {
        if (error.code === AuthErrorCode.USER_CANCELLED) {
          vscode.window.showInformationMessage('Login cancelled');
        } else {
          vscode.window.showErrorMessage(`Login failed: ${error.message}`);
        }
        throw error;
      }

      vscode.window.showErrorMessage(
        `Login failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      throw new AuthError(
        AuthErrorCode.UNKNOWN_ERROR,
        'Authentication failed',
        error,
      );
    }
  }

  /**
   * Remove an authentication session
   * Called when user logs out
   */
  public async removeSession(sessionId: string): Promise<void> {
    try {
      const sessions = await SessionManager.getSessions();
      const session = sessions.find((s) => s.id === sessionId);

      if (!session) {
        return;
      }

      // Cleanup strategy-specific data
      await this.strategy.cleanup(sessionId);

      // Remove session
      await SessionManager.removeSession(sessionId);

      // Notify VS Code of session change
      this._onDidChangeSessions.fire({
        added: [],
        removed: [session],
        changed: [],
      });

      vscode.window.showInformationMessage(
        `Logged out ${session.account.label}`,
      );
    } catch (error) {
      console.error('Error removing session:', error);
      vscode.window.showErrorMessage(
        `Logout failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Get the currently active session
   */
  public async getCurrentSession(): Promise<AuthSession | undefined> {
    return SessionManager.getCurrentSession();
  }

  /**
   * Switch to a different session
   */
  public async switchSession(sessionId: string): Promise<void> {
    const sessions = await SessionManager.getSessions();
    const session = sessions.find((s) => s.id === sessionId);

    if (!session) {
      throw new AuthError(
        AuthErrorCode.SESSION_NOT_FOUND,
        'Session not found',
      );
    }

    await SessionManager.setCurrentSession(sessionId);

    vscode.window.showInformationMessage(
      `Switched to account: ${session.account.label}`,
    );

    // Notify of session change
    this._onDidChangeSessions.fire({
      added: [],
      removed: [],
      changed: [session],
    });
  }

  /**
   * Logout all sessions
   */
  public async logoutAll(): Promise<void> {
    const sessions = await SessionManager.getSessions();

    if (sessions.length === 0) {
      vscode.window.showInformationMessage('No active sessions');
      return;
    }

    // Confirm logout all
    const confirm = await vscode.window.showWarningMessage(
      `Are you sure you want to logout all ${sessions.length} account(s)?`,
      { modal: true },
      'Logout All',
    );

    if (confirm !== 'Logout All') {
      return;
    }

    // Remove all sessions
    await SessionManager.removeAllSessions();

    // Notify VS Code of session changes
    this._onDidChangeSessions.fire({
      added: [],
      removed: sessions,
      changed: [],
    });

    vscode.window.showInformationMessage('Logged out all accounts');
  }

  /**
   * Clean up expired sessions
   */
  public async cleanupExpiredSessions(): Promise<void> {
    const cleaned = await SessionManager.cleanupExpiredSessions();
    if (cleaned > 0) {
      console.log(`Cleaned up ${cleaned} expired session(s)`);
    }
  }

  /**
   * Set authentication strategy
   */
  public setStrategy(strategy: AuthStrategy): void {
    this.strategy = strategy;
  }

  /**
   * Get current strategy name
   */
  public getStrategyName(): string {
    return this.strategy.name;
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this._onDidChangeSessions.dispose();
  }
}
