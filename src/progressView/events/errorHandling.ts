// Local imports - logger
import type { AgentLogger } from '@logger/AgentLogger';
import { serializeError } from '@utils/core';

/**
 * Type for error boundary functions created by createErrorBoundary.
 * Wraps async handlers to catch and log errors.
 */
export type ErrorBoundaryFn = (
  context: string,
  fn: () => unknown | Promise<unknown>,
) => void;

/** Serialize an error for logging, preserving original error reference. */
function serializeErrorForLog(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { ...serializeError(error), error };
  }
  return { error };
}

export function createErrorBoundary(
  logger: AgentLogger,
  moduleName: string,
): ErrorBoundaryFn {
  return (context: string, fn: () => unknown | Promise<unknown>): void => {
    try {
      const result = fn();
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        void (result as Promise<unknown>).catch((error) => {
          logger.error(`[${moduleName}] ${context}`, { data: serializeErrorForLog(error) });
        });
      }
    } catch (error) {
      logger.error(`[${moduleName}] ${context}`, { data: serializeErrorForLog(error) });
    }
  };
}
