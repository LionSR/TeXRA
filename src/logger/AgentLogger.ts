// Third-party imports
// (none needed)

// Local imports - log
import * as logger from './logUtils';

/**
 * Encapsulates logging functionality for agents with a dedicated channel.
 * Uses the updated consolidated logger system.
 */
export class AgentLogger {
  constructor(public channelId: string) {
    logger.initialize(this.channelId);
    this.channelId = channelId;
  }

  debug(message: string, groupId?: string): void {
    logger.debug(this.channelId, message, groupId);
  }

  info(message: string, groupId?: string): void {
    logger.info(this.channelId, message, groupId);
  }

  warn(message: string, groupId?: string): void {
    logger.warn(this.channelId, message, groupId);
  }

  error(message: string, groupId?: string): void {
    logger.error(this.channelId, message, groupId);
  }

  /**
   * Start a new log group and make it active for this logger.
   * @param groupName Name of the group to display
   * @param id Optional custom ID for the group
   * @param parentGroupId Optional parent group ID for nested groups
   * @returns The group ID
   */
  async startGroup(
    groupName: string,
    id?: string,
    parentGroupId?: string,
  ): Promise<string> {
    // wait for 50 mili seconds
    await new Promise((resolve) => setTimeout(resolve, 50));
    return logger.startGroup(this.channelId, groupName, id, parentGroupId);
  }

  /**
   * End the specified log group.
   * @param groupId ID of the group to end
   * @param status Status to set for the group ('error' or 'stopped')
   */
  endGroup(groupId: string, status: 'error' | 'stopped' = 'stopped'): void {
    logger.endGroup(this.channelId, groupId, status);
  }

  /**
   * Get the ID of the active log group for this logger.
   * @returns The active group ID, or undefined if no active group
   */
  getActiveGroupId(): string | undefined {
    return logger.getActiveGroupId(this.channelId);
  }

  /**
   * Set the active group ID for this logger.
   * @param groupId The group ID to set as active, or undefined to clear
   */
  setActiveGroupId(groupId: string | undefined): void {
    logger.setActiveGroupId(this.channelId, groupId);
  }
}
