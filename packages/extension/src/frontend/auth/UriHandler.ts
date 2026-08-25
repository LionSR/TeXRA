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
   * Accepts both paths in `AUTH_CALLBACK_PATHS`. Only `/auth-callback` is
   * produced today: the resolver builds every redirect from
   * `getAuthCallbackUri`, which hardcodes that path, and `asExternalUri` only
   * appends VS Code's `?state=` routing token. `/extension-auth-callback` is
   * retained tolerance for a web/Codespaces shape this repo no longer emits;
   * narrowing it needs a Codespaces sign-in check, not a grep.
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
