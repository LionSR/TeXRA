// Local imports - log
import type { AgentLogger, LoggerGroupOptions } from './AgentLogger';

export type WithLogGroupOptions = LoggerGroupOptions;

/**
 * Utility helper to start a log group, run a function, and automatically end the group.
 * @deprecated Use AgentLogger.withGroup directly instead.
 */
export async function withLogGroup<T>(
  logger: AgentLogger,
  groupName: string,
  fn: (groupId?: string) => Promise<T>,
  options: WithLogGroupOptions = {},
): Promise<T> {
  return logger.withGroup(groupName, fn, options);
}
