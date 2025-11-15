/**
 * Authentication module exports
 */

export { TeXRAAuthProvider } from './authProvider';
export { SessionManager } from './sessionManager';
export { AuthStatusBar } from './authStatusBar';
export { LocalStrategy } from './strategies/localStrategy';
export type {
  AuthSession,
  SessionMetadata,
  UserCredentials,
  AuthStrategy,
  AuthProviderConfig,
  UserProfile,
  UserUsage,
} from './types';
export { AuthEvent, AuthErrorCode, AuthError } from './types';
