/**
 * ManualRetryController manages pending retry tasks for streams.
 *
 * Architecture:
 * - `pendingRetries` Map is the single source of truth for retry task state
 * - Registration adds a task; removal happens via `removeRetryTask` or `executeRetry`
 * - UI notification events are emitted explicitly (not hidden in state management)
 *
 * Flow:
 * 1. BaseRetryWaitNode registers a task via `registerManualRetry`
 * 2. BaseRetryWaitNode emits 'showRetryRequest' to show the UI
 * 3. User clicks retry → backend calls `triggerManualRetry` → task executes → cleanup emits 'resolveRetryRequest'
 * 4. Or: timeout/cancel → cleanup calls `removeRetryTask` and emits 'resolveRetryRequest'
 */

// Local imports - logging
import type { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import { bus } from '@eventBus/ProgressEventBus';

export interface ManualRetryTask {
  run: () => Promise<unknown>;
  cancel?: () => void;
  logger: AgentLogger;
  operation: string;
  model?: string;
}

/** Single source of truth for pending retry tasks */
const pendingRetries = new Map<string, ManualRetryTask>();

/**
 * Generation counter per stream key to prevent race conditions.
 * Incremented on each registration to detect stale task completions.
 */
const taskGenerations = new Map<string, number>();

/**
 * Get the current generation for a key, or 0 if not set.
 */
function getGeneration(key: string): number {
  return taskGenerations.get(key) ?? 0;
}

/**
 * Increment and return the new generation for a key.
 */
function nextGeneration(key: string): number {
  const next = getGeneration(key) + 1;
  taskGenerations.set(key, next);
  return next;
}

/**
 * Register a manual retry task for a stream.
 * Does NOT emit UI events - caller is responsible for emitting 'showRetryRequest'.
 */
export function registerManualRetry(key: string, task: ManualRetryTask): void {
  nextGeneration(key);
  pendingRetries.set(key, task);
  task.logger.info(`Manual retry available for ${task.operation}`, {
    messageType: MESSAGE_TYPES.PROGRESS_STATUS,
    data: { model: task.model, operation: task.operation },
  });
}

/**
 * Check if a retry task is registered for a stream.
 */
export function hasManualRetry(key: string): boolean {
  return pendingRetries.has(key);
}

/**
 * Remove a retry task without executing it.
 * Returns true if an entry was removed.
 * Does NOT emit UI events - caller should emit 'resolveRetryRequest' if needed.
 */
export function removeRetryTask(key: string): boolean {
  const deleted = pendingRetries.delete(key);
  if (deleted) {
    taskGenerations.delete(key); // Clean up generation counter
  }
  return deleted;
}

/**
 * Remove a retry task and emit the UI resolution event.
 * Use this when cleanup requires UI notification.
 */
export function clearManualRetry(key: string): void {
  if (removeRetryTask(key)) {
    bus.emit('resolveRetryRequest', { streamId: key });
  }
}

/**
 * Cancel a manual retry for a stream.
 * Calls the task's cancel callback (if provided) and removes from registry.
 * Returns true if task was found and cancelled.
 */
export function cancelManualRetry(key: string): boolean {
  const task = pendingRetries.get(key);
  if (!task) {
    return false;
  }

  // Remove from registry first and clean up generation counter
  pendingRetries.delete(key);
  taskGenerations.delete(key);

  // Trigger cancel callback if provided (with error boundary)
  if (task.cancel) {
    try {
      task.cancel();
    } catch (error) {
      task.logger.error(`Cancel callback failed for ${task.operation}`, {
        messageType: MESSAGE_TYPES.PROGRESS_STATUS,
        data: { model: task.model, operation: task.operation, error },
      });
    }
  }

  task.logger.info(`Retry cancelled for ${task.operation}`, {
    messageType: MESSAGE_TYPES.PROGRESS_STATUS,
    data: { model: task.model, operation: task.operation },
  });

  // Emit UI resolution event
  bus.emit('resolveRetryRequest', { streamId: key });
  return true;
}

/**
 * Trigger a manual retry for a stream.
 * Executes the registered task and cleans up.
 * Emits 'resolveRetryRequest' after completion only if no new task was registered.
 */
export async function triggerManualRetry(key: string): Promise<boolean> {
  const task = pendingRetries.get(key);
  if (!task) {
    return false;
  }

  // Capture generation before execution to detect new registrations
  const startGeneration = getGeneration(key);

  // Remove from registry before execution
  pendingRetries.delete(key);

  task.logger.info(`Retry requested for ${task.operation}`, {
    messageType: MESSAGE_TYPES.PROGRESS_STATUS,
    data: { model: task.model, operation: task.operation },
  });

  try {
    await task.run();
    task.logger.info(`Retry succeeded for ${task.operation}`, {
      messageType: MESSAGE_TYPES.PROGRESS_STATUS,
      data: { model: task.model, operation: task.operation },
    });
    return true;
  } catch (error) {
    task.logger.error(`Retry failed for ${task.operation}`, {
      messageType: MESSAGE_TYPES.PROGRESS_STATUS,
      data: { model: task.model, operation: task.operation, error },
    });
    return false;
  } finally {
    // Only emit resolve if no new task was registered during execution
    // This prevents stale completions from dismissing new retry UI
    if (getGeneration(key) === startGeneration) {
      // Clean up generation counter to prevent memory leak
      taskGenerations.delete(key);
      bus.emit('resolveRetryRequest', { streamId: key });
    }
  }
}
