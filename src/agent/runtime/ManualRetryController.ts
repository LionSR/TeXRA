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
  logger: AgentLogger;
  operation: string;
  model?: string;
}

/** Single source of truth for pending retry tasks */
const pendingRetries = new Map<string, ManualRetryTask>();

/**
 * Register a manual retry task for a stream.
 * Does NOT emit UI events - caller is responsible for emitting 'showRetryRequest'.
 */
export function registerManualRetry(key: string, task: ManualRetryTask): void {
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
  return pendingRetries.delete(key);
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
 * Trigger a manual retry for a stream.
 * Executes the registered task and cleans up.
 * Emits 'resolveRetryRequest' after completion.
 */
export async function triggerManualRetry(key: string): Promise<boolean> {
  const task = pendingRetries.get(key);
  if (!task) {
    return false;
  }

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
    // Ensure UI is notified regardless of success/failure
    bus.emit('resolveRetryRequest', { streamId: key });
  }
}
