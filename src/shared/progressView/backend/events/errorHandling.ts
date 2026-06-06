// Local imports - logger
import { createChannelTrace } from '@logger';
import { serializeError } from '@utils/core';

// Shared logger for all event handlers
const eventLogger = createChannelTrace('ProgressEvents');

/** Serialize an error for logging, preserving original error reference. */
function toErrorData(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? { ...serializeError(error), error }
    : { error };
}

/** Check if a value is a thenable (has .catch method). */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof (value as PromiseLike<unknown>)?.then === 'function'
  );
}

/** Log an error with module context. */
function logError(moduleName: string, context: string, error: unknown): void {
  eventLogger.error(`[${moduleName}] ${context}`, { data: toErrorData(error) });
}

/**
 * Wraps an event handler with error logging.
 * Handles both sync and async handlers, logging any errors.
 */
export function withEventErrorHandling(
  moduleName: string,
  context: string,
  fn: () => unknown | Promise<unknown>,
): void {
  try {
    const result = fn();
    if (isThenable(result)) {
      void Promise.resolve(result).catch((error) =>
        logError(moduleName, context, error),
      );
    }
  } catch (error) {
    logError(moduleName, context, error);
  }
}
