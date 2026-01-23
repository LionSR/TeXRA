/**
 * Simple in-memory storage for pending state restoration.
 * This is used to pass state from the restore command to the MainViewProvider
 * when the webview is not yet available.
 */

import type { TaskState } from '@logger/TaskState';

interface PendingStateData {
  state: TaskState;
  executeImmediately?: boolean;
}

let pendingStateData: PendingStateData | undefined = undefined;

/**
 * Store state for later restoration.
 * @param state - The TaskState to restore
 * @param executeImmediately - If true, execute the agent after restoring state (for followup)
 */
export function setPendingState(
  state: TaskState,
  executeImmediately?: boolean,
): void {
  pendingStateData = { state, executeImmediately };
}

/**
 * Get and clear the pending state.
 * @returns The pending state data if any, undefined otherwise
 */
export function consumePendingState(): PendingStateData | undefined {
  const result = pendingStateData;
  pendingStateData = undefined;
  return result;
}
