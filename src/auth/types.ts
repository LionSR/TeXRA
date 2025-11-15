// Third-party imports
import * as vscode from 'vscode';

/**
 * Authentication session representing a logged-in user
 */
export interface AuthSession extends vscode.AuthenticationSession {
  /**
   * Unique session identifier
   */
  id: string;

  /**
   * User account information
   */
  account: {
    /**
     * Unique user ID
     */
    id: string;

    /**
     * Display name for the user
     */
    label: string;

    /**
     * Optional email address
     */
    email?: string;
  };

  /**
   * Access scopes granted for this session
   */
  scopes: readonly string[];

  /**
   * Access token (stored separately in SecretStorage)
   */
  accessToken: string;
}

/**
 * Session metadata (stored in GlobalState)
 */
export interface SessionMetadata {
  id: string;
  accountId: string;
  accountLabel: string;
  accountEmail?: string;
  scopes: string[];
  createdAt: number;
  expiresAt?: number;
  lastUsedAt: number;
}

/**
 * User credentials for local authentication
 */
export interface UserCredentials {
  username: string;
  password: string;
  email?: string;
}

/**
 * Authentication strategy interface
 */
export interface AuthStrategy {
  /**
   * Strategy name (e.g., 'local', 'oauth', 'custom')
   */
  readonly name: string;

  /**
   * Authenticate user and create session
   */
  authenticate(scopes: string[]): Promise<AuthSession>;

  /**
   * Validate an existing session
   */
  validateSession(session: AuthSession): Promise<boolean>;

  /**
   * Refresh session tokens if supported
   */
  refreshSession?(session: AuthSession): Promise<AuthSession>;

  /**
   * Cleanup on logout
   */
  cleanup(sessionId: string): Promise<void>;
}

/**
 * Authentication provider configuration
 */
export interface AuthProviderConfig {
  /**
   * Provider ID (must be unique)
   */
  id: string;

  /**
   * Display label
   */
  label: string;

  /**
   * Whether authentication is required
   */
  required: boolean;

  /**
   * Session timeout in seconds (0 = no timeout)
   */
  sessionTimeout: number;

  /**
   * Whether to persist sessions across restarts
   */
  rememberMe: boolean;

  /**
   * OAuth configuration (if using OAuth strategy)
   */
  oauth?: {
    clientId: string;
    authorizationUrl: string;
    tokenUrl: string;
    scopes: string[];
  };

  /**
   * Custom backend configuration (if using backend strategy)
   */
  backend?: {
    loginUrl: string;
    validateUrl: string;
    refreshUrl?: string;
  };
}

/**
 * User profile information
 */
export interface UserProfile {
  id: string;
  username: string;
  email?: string;
  displayName?: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

/**
 * Usage statistics for a user
 */
export interface UserUsage {
  userId: string;
  apiCalls: number;
  tokensUsed: number;
  lastUpdated: number;
  quotaLimit?: number;
  quotaRemaining?: number;
}

/**
 * Authentication events
 */
export enum AuthEvent {
  LOGIN = 'login',
  LOGOUT = 'logout',
  SESSION_CREATED = 'sessionCreated',
  SESSION_EXPIRED = 'sessionExpired',
  SESSION_REFRESHED = 'sessionRefreshed',
  ACCOUNT_SWITCHED = 'accountSwitched',
}

/**
 * Authentication error codes
 */
export enum AuthErrorCode {
  INVALID_CREDENTIALS = 'invalid_credentials',
  SESSION_EXPIRED = 'session_expired',
  SESSION_NOT_FOUND = 'session_not_found',
  TOKEN_REFRESH_FAILED = 'token_refresh_failed',
  NETWORK_ERROR = 'network_error',
  USER_CANCELLED = 'user_cancelled',
  UNKNOWN_ERROR = 'unknown_error',
}

/**
 * Authentication error
 */
export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}
