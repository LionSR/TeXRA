/**
 * Auth-related constants.
 * Separated from authCommands.ts to avoid circular dependencies.
 * SettingsViewMessageHandler needs AUTH_COMMANDS but authCommands needs settings.
 */

/** VS Code authentication provider ID for TeXRA. */
export const AUTH_PROVIDER_ID = 'texra-supabase';

/** Command IDs for authentication operations. */
export const AUTH_COMMANDS = {
  SIGN_IN: 'texra.auth.signIn',
  SIGN_OUT: 'texra.auth.signOut',
  VIEW_PROFILE: 'texra.auth.viewProfile',
} as const;
