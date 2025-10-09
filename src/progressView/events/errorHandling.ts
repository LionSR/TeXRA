// Local imports - logger
import type { AgentLogger } from '@logger/AgentLogger';

import type { ErrorBoundary } from './types';

export function createErrorBoundary(
  logger: AgentLogger,
  moduleName: string,
): ErrorBoundary {
  return (context: string, fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      const details =
        error instanceof Error
          ? { message: error.message, stack: error.stack, error }
          : { error };

      logger.error(`[${moduleName}] ${context}`, undefined, undefined, details);
    }
  };
}
