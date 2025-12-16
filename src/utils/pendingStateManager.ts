/**
 * Simple in-memory storage for pending state restoration.
 * This is used to pass state from the restore command to the MainViewProvider
 * when the webview is not yet available.
 */

import type { TaskState } from '@logger/TaskState';

let pendingState: TaskState | undefined = undefined;

/**
 * Store state for later restoration.
 */
export function setPendingState(state: TaskState): void {
  pendingState = state;
}

/**
 * Get and clear the pending state.
 * @returns The pending state if any, undefined otherwise
 */
export function consumePendingState(): TaskState | undefined {
  const state = pendingState;
  pendingState = undefined;
  return state;
}
