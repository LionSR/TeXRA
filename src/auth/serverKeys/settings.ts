/**
 * Settings management for server-side API key access.
 *
 * Handles the "use included model access" preference that Ultra/Max/free tier
 * users control via the profile view.
 */

import * as vscode from 'vscode';
import { clearAllCaches } from './cache';

/**
 * Global state key for the "use included model access" preference.
 * This is an internal setting (not exposed in VS Code settings) that
 * users control via the profile view.
 */
const USE_INCLUDED_ACCESS_KEY = 'texra.useIncludedModelAccess';

/**
 * In-memory state for the setting. Defaults to true (use included access).
 * This is loaded from globalState on initialization and can be updated
 * via setUseIncludedModelAccess().
 */
let useIncludedModelAccess: boolean = true;

/**
 * Reference to the extension context's globalState for persistence.
 * Set via initialize().
 */
let globalState: vscode.Memento | null = null;

/**
 * Event emitter for model access setting changes.
 * Fire this when the setting changes so listeners can refresh.
 */
const _onDidChangeModelAccess = new vscode.EventEmitter<boolean>();

/**
 * Event that fires when the "use included model access" setting changes.
 * Subscribe to this to refresh model options when the setting is toggled.
 */
export const onDidChangeModelAccess = _onDidChangeModelAccess.event;

/**
 * Initialize the settings module with the extension context.
 * Call this once during extension activation to enable state persistence.
 *
 * @param context - The VS Code extension context
 */
export function initialize(context: vscode.ExtensionContext): void {
  // Register EventEmitter for disposal when extension deactivates
  context.subscriptions.push(_onDidChangeModelAccess);

  globalState = context.globalState;
  // Load persisted value, defaulting to true (use included access)
  useIncludedModelAccess = globalState.get<boolean>(
    USE_INCLUDED_ACCESS_KEY,
    true,
  );
}

/**
 * Check if the "use included model access" setting is enabled.
 */
export function isEnabled(): boolean {
  return useIncludedModelAccess;
}

/**
 * Get the current "use included model access" preference.
 */
export function getUseIncludedModelAccess(): boolean {
  return useIncludedModelAccess;
}

/**
 * Set the "use included model access" preference.
 * This persists the setting to globalState and updates the in-memory value.
 * Also clears the access cache and fires the onDidChangeModelAccess event.
 *
 * @param value - True to use included access, false to use personal keys
 * @param preFetchCallback - Optional async callback to pre-fetch data when enabling
 */
export async function setUseIncludedModelAccess(
  value: boolean,
  preFetchCallback?: () => Promise<void>,
): Promise<void> {
  const changed = useIncludedModelAccess !== value;
  useIncludedModelAccess = value;

  if (globalState) {
    await globalState.update(USE_INCLUDED_ACCESS_KEY, value);
  }

  if (changed) {
    // Clear cache BEFORE fetching fresh data
    clearAllCaches();

    // If enabling and callback provided, pre-fetch data
    if (value && preFetchCallback) {
      await preFetchCallback();
    }

    _onDidChangeModelAccess.fire(value);
  }
}
