// Local imports - log
import type { AgentLogger } from './AgentLogger';

type GroupStatus = Parameters<AgentLogger['endGroup']>[1];

export interface WithLogGroupOptions {
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
  const {
    parentGroupId,
    skip = false,
    successStatus = 'stopped',
    errorStatus = 'error',
  } = options;

  if (skip) {
    return fn(undefined);
  }

  const groupId = await logger.startGroup(groupName, undefined, parentGroupId);

  try {
    const result = await fn(groupId);
    logger.endGroup(groupId, successStatus);
    return result;
  } catch (error) {
    logger.endGroup(groupId, errorStatus);
    throw error;
  }
}
