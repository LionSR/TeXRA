/**
 * Auth-related constants shared across hosts and tools: the VS Code
 * authentication provider ID plus the command IDs that webviews, the setup
 * agent, and host entry points dispatch via vscode.commands.executeCommand.
 */

/** VS Code authentication provider ID for TeXRA. */
export const AUTH_PROVIDER_ID = 'texra-supabase';

/** Command IDs for authentication operations. */
export const AUTH_COMMANDS = {
  SIGN_IN: 'texra.auth.signIn',
  SIGN_OUT: 'texra.auth.signOut',
  VIEW_PROFILE: 'texra.auth.viewProfile',
} as const;
