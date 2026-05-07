/**
 * Host-neutral disposable resource.
 *
 * Structurally compatible with VS Code's Disposable and the unsubscribe
 * callbacks used by Electron-side adapters.
 */
export interface Disposable {
  dispose(): void;
}
