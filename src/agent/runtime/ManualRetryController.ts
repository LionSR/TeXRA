// Local imports - logging
import type { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import { bus } from '@eventBus/ProgressEventBus';

interface ManualRetryTask {
  run: () => Promise<unknown>;
  logger: AgentLogger;
  operation: string;
  model?: string;
}

const pendingRetries = new Map<string, ManualRetryTask>();

export function registerManualRetry(key: string, task: ManualRetryTask): void {
  pendingRetries.set(key, task);
  task.logger.info(`Manual retry available for ${task.operation}`, {
    messageType: MESSAGE_TYPES.PROGRESS_STATUS,
    data: { model: task.model, operation: task.operation },
  });
}

export function clearManualRetry(key: string): void {
  const hadEntry = pendingRetries.has(key);
  pendingRetries.delete(key);
  if (hadEntry) {
    bus.emit('resolveRetryRequest', { streamId: key });
  }
}

export async function triggerManualRetry(key: string): Promise<boolean> {
  const task = pendingRetries.get(key);
  if (!task) {
    return false;
  }

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
  }
}
