/**
 * Resolve a `targetOrigin` for `window.postMessage` from a given origin string.
 *
 * Electron loads the desktop renderer over `file://`, where `origin` is the
 * literal string `"null"`. In that case we must pass `"*"` to avoid the
 * browser dropping the message. VS Code webviews load over `vscode-webview://`
 * with a real origin, which passes through unchanged.
 *
 * Parameterized on the origin so both the desktop renderer (reading
 * `window.location.origin`) and the Electron preload (reading the renderer
 * window's possibly-undefined `location?.origin`) share one fallback.
 */
export function resolvePostMessageTargetOrigin(
  origin: string | undefined | null,
): string {
  return origin && origin !== 'null' ? origin : '*';
}
