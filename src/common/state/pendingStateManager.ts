/**
 * Simple in-memory storage for pending state restoration.
 * This is used to pass state from the restore command to the MainViewProvider
 * when the webview is not yet available.
 */
// Local imports - shared schemas
import type { MainViewPersistedState } from '@shared/schemas';

interface PendingStateData {
  state: MainViewPersistedState;
  executeImmediately?: boolean;
}

const MAX_PENDING_STATES = 10;
const pendingStateQueue: PendingStateData[] = [];

/**
 * Store state for later restoration.
 * @param state - The MainView state to restore
 * @param executeImmediately - If true, execute the agent after restoring state (for followup)
 */
export function setPendingState(
  state: MainViewPersistedState,
  executeImmediately?: boolean,
): void {
  if (pendingStateQueue.length >= MAX_PENDING_STATES) {
    pendingStateQueue.shift();
  }
  pendingStateQueue.push({ state, executeImmediately });
}

/**
 * Get and clear the pending state.
 * @returns The pending state data if any, undefined otherwise
 */
export function consumePendingState(): PendingStateData | undefined {
  return pendingStateQueue.shift();
}
