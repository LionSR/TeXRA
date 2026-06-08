/**
 * Decouples agent runtime from ProgressView UI layer.
 *
 * Provides a narrow port the runtime can query to know whether the
 * ProgressView panel is already open — so it avoids force-opening or
 * showing a duplicate notification when the view is already visible.
 */

/** Implemented by ProgressViewProvider (VS Code) and the desktop bridge. */
export interface IProgressViewBridge {
  isViewVisible(): boolean;
}

let bridge: IProgressViewBridge | null = null;

const DEFAULT_BRIDGE: IProgressViewBridge = {
  isViewVisible: () => false,
};

export function setProgressViewBridge(b: IProgressViewBridge): void {
  bridge = b;
}

/** Returns the registered bridge, or a safe no-op default if not registered. */
export function getProgressViewBridge(): IProgressViewBridge {
  return bridge ?? DEFAULT_BRIDGE;
}
