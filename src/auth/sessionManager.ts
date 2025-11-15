// Third-party imports
import * as vscode from 'vscode';
import { nanoid } from 'nanoid';

// Local imports
import { SecretManager } from '@frontend/secretManager';
import { globalSM } from '@common/state/stateManager';
import type { AuthSession, SessionMetadata } from './types';
import { AuthError, AuthErrorCode } from './types';

/**
 * Manages authentication sessions with persistence
 */
export class SessionManager {
  private static readonly SESSIONS_KEY = 'texra.auth.sessions';
  private static readonly CURRENT_SESSION_KEY = 'texra.auth.currentSession';
  private static readonly TOKEN_PREFIX = 'auth.session';

  /**
   * Create a new authentication session
   */
  public static async createSession(
    accountId: string,
    accountLabel: string,
    accessToken: string,
    options: {
      email?: string;
      scopes?: string[];
      expiresIn?: number;
    } = {},
  ): Promise<AuthSession> {
    const sessionId = nanoid();
    const now = Date.now();
    const expiresAt = options.expiresIn
      ? now + options.expiresIn * 1000
      : undefined;

    // Create session metadata
    const metadata: SessionMetadata = {
      id: sessionId,
      accountId,
      accountLabel,
      accountEmail: options.email,
      scopes: options.scopes || [],
      createdAt: now,
      expiresAt,
      lastUsedAt: now,
    };

    // Store access token in SecretStorage
    await this.storeToken(sessionId, accessToken);

    // Store metadata in GlobalState
    await this.saveSessionMetadata(metadata);

    // Set as current session
    await this.setCurrentSession(sessionId);

    // Return full session object
    return this.buildAuthSession(metadata, accessToken);
  }

  /**
   * Get all active sessions
   */
  public static async getSessions(): Promise<AuthSession[]> {
    const allMetadata = await this.getAllSessionMetadata();

    // Filter out expired sessions
    const validMetadata = allMetadata.filter((meta) => {
      if (meta.expiresAt && meta.expiresAt < Date.now()) {
        // Clean up expired session
        this.removeSession(meta.id).catch(console.error);
        return false;
      }
      return true;
    });

    // Build full session objects
    const sessions = await Promise.all(
      validMetadata.map(async (meta) => {
        const token = await this.getToken(meta.id);
        if (!token) {
          // Token missing, clean up metadata
          await this.removeSession(meta.id);
          return null;
        }
        return this.buildAuthSession(meta, token);
      }),
    );

    return sessions.filter((s): s is AuthSession => s !== null);
  }

  /**
   * Get current active session
   */
  public static async getCurrentSession(): Promise<AuthSession | undefined> {
    const sessionId = globalSM.get<string>(this.CURRENT_SESSION_KEY);
    if (!sessionId) {
      return undefined;
    }

    const sessions = await this.getSessions();
    const session = sessions.find((s) => s.id === sessionId);

    if (!session) {
      // Current session no longer exists, clear the reference
      await globalSM.update(this.CURRENT_SESSION_KEY, undefined);
      return undefined;
    }

    // Update last used timestamp
    await this.updateLastUsed(sessionId);

    return session;
  }

  /**
   * Set the current active session
   */
  public static async setCurrentSession(
    sessionId: string | undefined,
  ): Promise<void> {
    await globalSM.update(this.CURRENT_SESSION_KEY, sessionId);
  }

  /**
   * Remove a session
   */
  public static async removeSession(sessionId: string): Promise<void> {
    // Remove token from SecretStorage
    await this.deleteToken(sessionId);

    // Remove metadata from GlobalState
    await this.deleteSessionMetadata(sessionId);

    // Clear current session if it matches
    const currentSessionId = globalSM.get<string>(this.CURRENT_SESSION_KEY);
    if (currentSessionId === sessionId) {
      await globalSM.update(this.CURRENT_SESSION_KEY, undefined);
    }
  }

  /**
   * Remove all sessions
   */
  public static async removeAllSessions(): Promise<void> {
    const sessions = await this.getAllSessionMetadata();

    await Promise.all(
      sessions.map((session) => this.removeSession(session.id)),
    );

    await globalSM.update(this.CURRENT_SESSION_KEY, undefined);
  }

  /**
   * Validate a session
   */
  public static async validateSession(
    sessionId: string,
  ): Promise<boolean> {
    const sessions = await this.getSessions();
    return sessions.some((s) => s.id === sessionId);
  }

  /**
   * Update session access token
   */
  public static async updateSessionToken(
    sessionId: string,
    newAccessToken: string,
    expiresIn?: number,
  ): Promise<void> {
    // Update token in SecretStorage
    await this.storeToken(sessionId, newAccessToken);

    // Update expiry if provided
    if (expiresIn !== undefined) {
      const metadata = await this.getSessionMetadata(sessionId);
      if (metadata) {
        metadata.expiresAt = Date.now() + expiresIn * 1000;
        await this.saveSessionMetadata(metadata);
      }
    }
  }

  /**
   * Get session metadata by ID
   */
  public static async getSessionMetadata(
    sessionId: string,
  ): Promise<SessionMetadata | undefined> {
    const allMetadata = await this.getAllSessionMetadata();
    return allMetadata.find((m) => m.id === sessionId);
  }

  /**
   * Update last used timestamp
   */
  private static async updateLastUsed(sessionId: string): Promise<void> {
    const metadata = await this.getSessionMetadata(sessionId);
    if (metadata) {
      metadata.lastUsedAt = Date.now();
      await this.saveSessionMetadata(metadata);
    }
  }

  /**
   * Store session token in SecretStorage
   */
  private static async storeToken(
    sessionId: string,
    token: string,
  ): Promise<void> {
    const key = `${this.TOKEN_PREFIX}.${sessionId}.accessToken`;
    await SecretManager.set(key, token);
  }

  /**
   * Get session token from SecretStorage
   */
  private static async getToken(
    sessionId: string,
  ): Promise<string | undefined> {
    const key = `${this.TOKEN_PREFIX}.${sessionId}.accessToken`;
    return SecretManager.get(key);
  }

  /**
   * Delete session token from SecretStorage
   */
  private static async deleteToken(sessionId: string): Promise<void> {
    const key = `${this.TOKEN_PREFIX}.${sessionId}.accessToken`;
    await SecretManager.delete(key);
  }

  /**
   * Get all session metadata from GlobalState
   */
  private static async getAllSessionMetadata(): Promise<SessionMetadata[]> {
    return globalSM.get<SessionMetadata[]>(this.SESSIONS_KEY, []);
  }

  /**
   * Save session metadata to GlobalState
   */
  private static async saveSessionMetadata(
    metadata: SessionMetadata,
  ): Promise<void> {
    const allMetadata = await this.getAllSessionMetadata();
    const index = allMetadata.findIndex((m) => m.id === metadata.id);

    if (index >= 0) {
      allMetadata[index] = metadata;
    } else {
      allMetadata.push(metadata);
    }

    await globalSM.update(this.SESSIONS_KEY, allMetadata);
  }

  /**
   * Delete session metadata from GlobalState
   */
  private static async deleteSessionMetadata(sessionId: string): Promise<void> {
    const allMetadata = await this.getAllSessionMetadata();
    const filtered = allMetadata.filter((m) => m.id !== sessionId);
    await globalSM.update(this.SESSIONS_KEY, filtered);
  }

  /**
   * Build AuthSession object from metadata and token
   */
  private static buildAuthSession(
    metadata: SessionMetadata,
    accessToken: string,
  ): AuthSession {
    return {
      id: metadata.id,
      account: {
        id: metadata.accountId,
        label: metadata.accountLabel,
        email: metadata.accountEmail,
      },
      scopes: metadata.scopes,
      accessToken,
    };
  }

  /**
   * Clean up expired sessions
   */
  public static async cleanupExpiredSessions(): Promise<number> {
    const allMetadata = await this.getAllSessionMetadata();
    const now = Date.now();
    let cleaned = 0;

    for (const metadata of allMetadata) {
      if (metadata.expiresAt && metadata.expiresAt < now) {
        await this.removeSession(metadata.id);
        cleaned++;
      }
    }

    return cleaned;
  }
}
