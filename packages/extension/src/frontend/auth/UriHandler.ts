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
   * Accepts both paths in `AUTH_CALLBACK_PATHS`. Every redirect this repo
   * builds goes through `getAuthCallbackUri`, which hardcodes `/auth-callback`.
   * What `asExternalUri` does to that URI in a web/Codespaces workbench is VS
   * Code's business, not something this repo can assert — which is exactly why
   * `/extension-auth-callback` is still accepted. Do NOT narrow
   * `AUTH_CALLBACK_PATHS` on the strength of a grep; it needs a real Codespaces
   * sign-in check.
   */
  handleUri(uri: vscode.Uri): vscode.ProviderResult<void> {
    // The routed-back URI carries VS Code's ?state= token on the path, so the
    // check is on the base path only.
    if (isAuthCallbackPath(uri.path)) {
      // Fire event so the auth provider can handle it
      this._onDidReceiveCallback.fire(uri);
    }
  }
}
