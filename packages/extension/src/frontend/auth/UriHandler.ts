import * as vscode from 'vscode';
import { isAuthCallbackPath } from '@auth/authCallback';

/**
 * URI handler for OAuth callbacks.
 * Handles the redirect from Supabase OAuth flow.
 */
export class SupabaseUriHandler implements vscode.UriHandler {
  private _onDidReceiveCallback = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidReceiveCallback = this._onDidReceiveCallback.event;

  /**
   * Handle incoming URIs from OAuth callbacks.
   * This is called when the user is redirected back from the OAuth provider.
   *
   * Accepts both paths:
   * - /auth-callback: Used by desktop VS Code (vscode://, cursor://)
   * - /extension-auth-callback: Used by VS Code web/Codespaces (https://*.github.dev/)
   */
  handleUri(uri: vscode.Uri): vscode.ProviderResult<void> {
    // Check if this is an auth callback (both desktop and web/Codespaces paths)
    // In Codespaces, the state param may be URL-encoded into the path (e.g., /extension-auth-callback?state=xxx)
    if (isAuthCallbackPath(uri.path)) {
      // Fire event so the auth provider can handle it
      this._onDidReceiveCallback.fire(uri);
    }
  }
}
