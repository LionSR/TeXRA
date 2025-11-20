// Local imports - logger
import type { AgentLogger } from '@logger/AgentLogger';

export function createErrorBoundary(
  logger: AgentLogger,
  moduleName: string,
): (context: string, fn: () => unknown | Promise<unknown>) => void {
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
