import type * as vscode from 'vscode';

/**
 * Register authentication-related commands.
 *
 * `texra.auth.signIn`, `texra.auth.signOut`, and `texra.auth.viewProfile`
 * are now dispatched through the shared command registry (see #3771 and
 * `extensionCommandSurface.ts`), so this function is intentionally a
 * no-op kept around for the import call site in `commands.ts`.
 */
export function registerAuthCommands(
  _context: vscode.ExtensionContext,
): vscode.Disposable[] {
  return [];
}

// Re-export AUTH_COMMANDS for external use
export { AUTH_COMMANDS } from '@auth/constants';
export { getAuthStatus } from '@auth/authCommands';
