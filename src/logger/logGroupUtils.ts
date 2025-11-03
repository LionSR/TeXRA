// Local imports - log
import type { AgentLogger } from './AgentLogger';

type GroupStatus = Parameters<AgentLogger['endGroup']>[1];

interface WithLogGroupOptions {
  parentGroupId?: string;
  skip?: boolean;
  successStatus?: GroupStatus;
  errorStatus?: GroupStatus;
}

/**
 * Utility helper to start a log group, run a function, and automatically end the group.
 */
export async function withLogGroup<T>(
  logger: AgentLogger,
  groupName: string,
  fn: (groupId?: string) => Promise<T>,
  options: WithLogGroupOptions = {},
): Promise<T> {
  const { parentGroupId, skip = false, successStatus, errorStatus } = options;

  return logger.withScope(
    groupName,
    () => fn(logger.getActiveGroupId() ?? parentGroupId),
    {
      parentGroupId,
      skip,
      successStatus,
      errorStatus,
    },
  );
}
