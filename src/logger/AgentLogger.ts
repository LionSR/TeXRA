// Third-party imports
// (none needed)

// Local imports - log
import * as logger from './logUtils';
import { runWithChannelGroup } from './logContext';
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

  /**
   * Options used to control group lifecycle behaviour when using withGroup.
   */
  public static readonly defaultGroupStatus = {
    success: 'stopped' as const,
    error: 'error' as const,
  };

  debug(message: string, ...args: unknown[]): void {
    const { messageType, data } = AgentLogger.resolveLogArguments(args);
    logger.debug(
      this.channelId,
      message,
      undefined,
      messageType,
      this.isAgentLogger,
      data,
    );
  }

  info(message: string, ...args: unknown[]): void {
    const { messageType, data } = AgentLogger.resolveLogArguments(args);
    logger.info(
      this.channelId,
      message,
      undefined,
      messageType,
      this.isAgentLogger,
      data,
    );
  }

  warn(message: string, ...args: unknown[]): void {
    const { messageType, data } = AgentLogger.resolveLogArguments(args);
    logger.warn(
      this.channelId,
      message,
      undefined,
      messageType,
      this.isAgentLogger,
      data,
    );
  }

  error(message: string, ...args: unknown[]): void {
    const { messageType, data } = AgentLogger.resolveLogArguments(args);
    logger.error(
      this.channelId,
      message,
      undefined,
      messageType,
      this.isAgentLogger,
      data,
    );
  }

  /**
   * Log a list of files that were processed.
   */
  fileList(files: unknown[]): void {
    const summary = `Loaded ${files.length} file${files.length === 1 ? '' : 's'}`;
    this.info(summary, MESSAGE_TYPES.FILE_LIST, files);
  }

  /**
   * Log missing output information.
   */
  missingOutputs(info: unknown): void {
    const missing = (info as any).missing as unknown[] | undefined;
    const count = missing ? missing.length : 0;
    const summary = `${count} output file${count === 1 ? '' : 's'} missing`;
    this.info(summary, MESSAGE_TYPES.MISSING_OUTPUTS, info);
  }

  /**
   * Log latexdiff results.
   */
  latexDiff(results: unknown[]): void {
    const summary = `Latexdiff results: ${results.length}`;
    this.info(summary, MESSAGE_TYPES.LATEXDIFF, results);
  }

  /**
   * Log statistics information (only shown in debug mode).
   */
  statistics(stats: ExtendedTokenUsageStats): void {
    const summary = `Usage - input: ${stats.inputTokens ?? 0}, output: ${stats.outputTokens ?? 0}`;
    this.debug(summary, MESSAGE_TYPES.STATISTICS, stats);
  }

  /**
   * Log a user follow-up message.
   */
  userMessage(message: string): void {
    this.info(message, MESSAGE_TYPES.USER_MESSAGE);
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

  /**
   * Run the provided callback within a log group scope, automatically handling
   * start/end semantics and ensuring the group remains active for asynchronous
   * work spawned by the callback.
   */
  async withGroup<T>(
    groupName: string,
    fn: (groupId?: string) => Promise<T>,
    options: LoggerGroupOptions = {},
  ): Promise<T> {
    const {
      parentGroupId,
      skip = false,
      successStatus = AgentLogger.defaultGroupStatus.success,
      errorStatus = AgentLogger.defaultGroupStatus.error,
    } = options;

    if (skip) {
      return fn(undefined);
    }

    const groupId = await this.startGroup(groupName, undefined, parentGroupId);

    return runWithChannelGroup(this.channelId, groupId, async () => {
      try {
        const result = await fn(groupId);
        this.endGroup(groupId, successStatus);
        return result;
      } catch (error) {
        this.endGroup(groupId, errorStatus);
        throw error;
      }
    });
  }

  private static resolveLogArguments(args: unknown[]): {
    messageType?: MessageType;
    data?: unknown;
  } {
    if (args.length === 0) {
      return {};
    }

    const [first, second, third] = args;

    if (AgentLogger.isMessageType(first)) {
      return { messageType: first, data: second };
    }

    if (AgentLogger.isMessageType(second)) {
      return { messageType: second, data: third };
    }

    if (args.length === 1) {
      return { data: first };
    }

    if (args.length === 2) {
      return { data: second };
    }

    return { data: third };
  }

  private static isMessageType(value: unknown): value is MessageType {
    return (
      typeof value === 'string' &&
      Object.values(MESSAGE_TYPES).includes(value as MessageType)
    );
  }
}

type GroupStatus = Parameters<typeof logger.endGroup>[2];

export interface LoggerGroupOptions {
  parentGroupId?: string;
  skip?: boolean;
  successStatus?: GroupStatus;
  errorStatus?: GroupStatus;
}
