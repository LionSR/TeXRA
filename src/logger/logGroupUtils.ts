// Local imports - log
import type { AgentLogger, GroupScopedLogger } from './AgentLogger';

type GroupStatus = Parameters<AgentLogger['endGroup']>[1];

interface WithLogGroupOptions {
  parentGroupId?: string;
  skip?: boolean;
  successStatus?: GroupStatus;
  errorStatus?: GroupStatus;
}

export interface LogGroupContext {
  groupId: string;
  logger: GroupScopedLogger;
}

/**
 * Utility helper to start a log group, run a function, and automatically end the group.
 */
export async function withLogGroup<T>(
  logger: AgentLogger,
  groupName: string,
  fn: (context: LogGroupContext | undefined) => Promise<T>,
  options: WithLogGroupOptions = {},
): Promise<T> {
  const {
    skip = false,
    successStatus = 'stopped',
    errorStatus = 'error',
  } = options;

  if (skip) {
    return fn(undefined);
  }

  const previousGroupId = logger.getActiveGroupId();
  const resolvedParentGroupId =
    options.parentGroupId === undefined
      ? previousGroupId
      : options.parentGroupId;
  const groupId = await logger.startGroup(
    groupName,
    undefined,
    resolvedParentGroupId,
  );
  const groupLogger = logger.createGroupLogger(groupId);

  logger.setActiveGroupId(groupId);

  try {
    const result = await fn({ groupId, logger: groupLogger });
    logger.endGroup(groupId, successStatus);
    return result;
  } catch (error) {
    logger.endGroup(groupId, errorStatus);
    throw error;
  } finally {
    logger.setActiveGroupId(previousGroupId);
  }
}
