// Third-party imports
// (none needed)

// Local imports - log
import * as logger from './logUtils';
import type { MessageType } from './messageTypes';
import { MESSAGE_TYPES } from './messageTypes';
import type {
  TokenUsageStats,
  ExtendedTokenUsageStats,
} from '@agent/types/UsageTypes';
import { sleep } from '@utils/helpers';
import { SHORT_SLEEP_MS } from '@utils/config';

/**
 * Encapsulates logging functionality for agents with a dedicated channel.
 * Uses the updated consolidated logger system.
 */
export class AgentLogger {
  public readonly isAgentLogger: boolean;

  constructor(
    public channelId: string,
    isAgentLogger = false,
  ) {
    this.isAgentLogger = isAgentLogger;
    logger.initialize(this.channelId, this.isAgentLogger);
    this.channelId = channelId;
  }

  debug(
    message: string,
    groupId?: string,
    messageType?: MessageType,
    data?: unknown,
  ): void {
    logger.debug(
      this.channelId,
      message,
      groupId,
      messageType,
      this.isAgentLogger,
      data,
    );
  }

  info(
    message: string,
    groupId?: string,
    messageType?: MessageType,
    data?: unknown,
  ): void {
    logger.info(
      this.channelId,
      message,
      groupId,
      messageType,
      this.isAgentLogger,
      data,
    );
  }

  warn(
    message: string,
    groupId?: string,
    messageType?: MessageType,
    data?: unknown,
  ): void {
    logger.warn(
      this.channelId,
      message,
      groupId,
      messageType,
      this.isAgentLogger,
      data,
    );
  }

  error(
    message: string,
    groupId?: string,
    messageType?: MessageType,
    data?: unknown,
  ): void {
    logger.error(
      this.channelId,
      message,
      groupId,
      messageType,
      this.isAgentLogger,
      data,
    );
  }

  /**
   * Log a list of files that were processed.
   */
  fileList(files: unknown[], groupId?: string): void {
    const summary = `Loaded ${files.length} file${files.length === 1 ? '' : 's'}`;
    this.info(summary, groupId, MESSAGE_TYPES.FILE_LIST, files);
  }

  /**
   * Log missing output information.
   */
  missingOutputs(info: unknown, groupId?: string): void {
    const missing = (info as any).missing as unknown[] | undefined;
    const count = missing ? missing.length : 0;
    const summary = `${count} output file${count === 1 ? '' : 's'} missing`;
    this.info(summary, groupId, MESSAGE_TYPES.MISSING_OUTPUTS, info);
  }

  /**
   * Log latexdiff results.
   */
  latexDiff(results: unknown[], groupId?: string): void {
    const summary = `Latexdiff results: ${results.length}`;
    this.info(summary, groupId, MESSAGE_TYPES.LATEXDIFF, results);
  }

  /**
   * Log statistics information (only shown in debug mode).
   */
  statistics(stats: ExtendedTokenUsageStats, groupId?: string): void {
    const summary = `Usage - input: ${stats.inputTokens ?? 0}, output: ${stats.outputTokens ?? 0}`;
    this.debug(summary, groupId, MESSAGE_TYPES.STATISTICS, stats);
  }

  /**
   * Log a user follow-up message.
   */
  userMessage(message: string, groupId?: string): void {
    this.info(message, groupId, MESSAGE_TYPES.USER_MESSAGE);
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
    // brief delay to ensure log order
    await sleep(SHORT_SLEEP_MS);
    return logger.startGroup(
      this.channelId,
      groupName,
      id,
      parentGroupId,
      this.isAgentLogger,
    );
  }

  /**
   * End the specified log group.
   * @param groupId ID of the group to end
   * @param status Status to set for the group ('error' or 'stopped')
   */
  endGroup(groupId: string, status: 'error' | 'stopped' = 'stopped'): void {
    logger.endGroup(this.channelId, groupId, status, this.isAgentLogger);
  }

  /**
   * Get the ID of the active log group for this logger.
   * @returns The active group ID, or undefined if no active group
   */
  getActiveGroupId(): string | undefined {
    return logger.getActiveGroupId(this.channelId, this.isAgentLogger);
  }

  /**
   * Set the active group ID for this logger.
   * @param groupId The group ID to set as active, or undefined to clear
   */
  setActiveGroupId(groupId: string | undefined): void {
    logger.setActiveGroupId(this.channelId, groupId, this.isAgentLogger);
  }
}
