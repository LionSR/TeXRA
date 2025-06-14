// Utility functions for frontend

/**
 * Generate a nonce string for Webview content security policies.
 * @param length Length of the generated nonce
 */
export function generateNonce(length = 32): string {
  const possible =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
