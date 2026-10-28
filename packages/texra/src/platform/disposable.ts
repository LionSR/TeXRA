/**
 * A synchronous resource with one owner. Structurally compatible with VS
 * Code's Disposable and the unsubscribe callbacks Electron-side adapters use.
 */
export interface Disposable {
  dispose(): void;
}
