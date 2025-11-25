import * as vscode from 'vscode';

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
   */
  handleUri(uri: vscode.Uri): vscode.ProviderResult<void> {
    // Check if this is an auth callback
    if (uri.path === '/auth-callback') {
      // Fire event so the auth provider can handle it
      this._onDidReceiveCallback.fire(uri);
    }
  }
}
