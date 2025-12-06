// Local imports - logger
import type { AgentLogger } from '@logger/AgentLogger';

/**
 * Type for error boundary functions created by createErrorBoundary.
 * Wraps async handlers to catch and log errors.
 */
export type ErrorBoundaryFn = (
  context: string,
  fn: () => unknown | Promise<unknown>,
) => void;

export function createErrorBoundary(
  logger: AgentLogger,
  moduleName: string,
): ErrorBoundaryFn {
  return (context: string, fn: () => unknown | Promise<unknown>): void => {
    try {
      const result = fn();
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        void (result as Promise<unknown>).catch((error) => {
          const details =
            error instanceof Error
              ? { message: error.message, stack: error.stack, error }
              : { error };
          logger.error(`[${moduleName}] ${context}`, { data: details });
        });
      }
    } catch (error) {
      const details =
        error instanceof Error
          ? { message: error.message, stack: error.stack, error }
          : { error };
      logger.error(`[${moduleName}] ${context}`, { data: details });
    }
  };
}
