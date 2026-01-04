// Local imports - logger
import { AgentLogger } from '@logger/AgentLogger';
import { serializeError } from '@utils/core';

/** Serialize an error for logging, preserving original error reference. */
function serializeErrorForLog(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { ...serializeError(error), error };
  }
  return { error };
}

// Shared logger for all event handlers - eliminates per-module logger instances
const eventLogger = new AgentLogger('ProgressEvents');

/**
 * Wraps an async event handler with error logging.
 * Single source of truth for event error handling.
 *
 * @param moduleName - Module name for error context (e.g., 'LogEvents')
 * @param context - Error context message (e.g., 'failed to handle addLogMessage')
 * @param fn - The async handler function to wrap
 */
export function withEventErrorHandling(
  moduleName: string,
  context: string,
  fn: () => unknown | Promise<unknown>,
): void {
  try {
    const result = fn();
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      void (result as Promise<unknown>).catch((error) => {
        eventLogger.error(`[${moduleName}] ${context}`, {
          data: serializeErrorForLog(error),
        });
      });
    }
  } catch (error) {
    eventLogger.error(`[${moduleName}] ${context}`, {
      data: serializeErrorForLog(error),
    });
  }
}
