/**
 * Simple in-memory storage for pending state restoration.
 * This is used to pass state from the restore command to the MainViewProvider
 * when the webview is not yet available.
 *
 * Design notes:
 * - Use getPendingState() to read without clearing (for inspection)
 * - Use clearPendingState() to explicitly clear after processing
 * - consumePendingState() combines both for atomic get-and-clear operations
 */

import type { TaskState } from '@logger/TaskState';

let pendingState: TaskState | undefined = undefined;

/**
 * Store state for later restoration.
 * Overwrites any existing pending state.
 */
export function setPendingState(state: TaskState): void {
  pendingState = state;
}

/**
 * Get the pending state without clearing it.
 * Use this when you need to inspect the state before deciding to process it.
 * @returns The pending state if any, undefined otherwise
 */
export function getPendingState(): TaskState | undefined {
  return pendingState;
}

/**
 * Clear the pending state.
 * Call this after successfully processing the state.
 */
export function clearPendingState(): void {
  pendingState = undefined;
}

/**
 * Get and clear the pending state atomically.
 * Prefer using getPendingState() + clearPendingState() separately
 * when you need to handle errors during processing.
 * @returns The pending state if any, undefined otherwise
 */
export function consumePendingState(): TaskState | undefined {
  const state = pendingState;
  pendingState = undefined;
  return state;
}

/**
 * Check if there is pending state without consuming it.
 */
export function hasPendingState(): boolean {
  return pendingState !== undefined;
}
