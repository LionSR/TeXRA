// Local imports - log
import { AgentLogger } from './AgentLogger';
import type { MessageType } from './messageTypes';
import type {
  TokenUsageStats,
  ExtendedTokenUsageStats,
} from '@agent/types/UsageTypes';

/**
 * Extended logger that maintains an internal scope stack for automatic
 * group ID management. This eliminates the need to manually pass groupId
 * to every log call.
 *
 * Example usage:
 * ```typescript
 * const logger = new ScopedAgentLogger(channelId);
 *
 * await logger.withGroup('Processing', async () => {
 *   logger.info('Started'); // Automatically uses 'Processing' group
 *
 *   await logger.withGroup('SubTask', async () => {
 *     logger.debug('Details'); // Uses 'SubTask' group
 *   });
 *
 *   logger.info('Done'); // Back to 'Processing' group
 * });
 * ```
 */
export class ScopedAgentLogger extends AgentLogger {
  private scopeStack: string[] = [];

  /**
   * Execute a function within a log group scope.
   * The group is automatically started before the function runs,
   * and ended when it completes (or errors).
   *
   * @param name Name of the group to display
   * @param callback Function to execute within the group scope
   * @param parentId Optional parent group ID (defaults to current scope)
   * @returns Result of the callback function
   */
  async withGroup<T>(
    name: string,
    callback: () => Promise<T>,
    parentId?: string,
  ): Promise<T> {
    const effectiveParentId = parentId ?? this.getCurrentScope();
    const groupId = await this.startGroup(name, undefined, effectiveParentId);

    this.scopeStack.push(groupId);

    try {
      const result = await callback();
      this.endGroup(groupId, 'stopped');
      return result;
    } catch (error) {
      this.endGroup(groupId, 'error');
      throw error;
    } finally {
      this.scopeStack.pop();
    }
  }

  /**
   * Execute a function within a log group scope, with conditional execution.
   * If skip is true, the callback runs without creating a group.
   *
   * @param name Name of the group to display
   * @param callback Function to execute, receives groupId if group was created
   * @param options Configuration options
   * @returns Result of the callback function
   */
  async withGroupConditional<T>(
    name: string,
    callback: (groupId?: string) => Promise<T>,
    options: {
      skip?: boolean;
      parentId?: string;
      successStatus?: 'error' | 'stopped';
      errorStatus?: 'error' | 'stopped';
    } = {},
  ): Promise<T> {
    const {
      skip = false,
      parentId,
      successStatus = 'stopped',
      errorStatus = 'error',
    } = options;

    if (skip) {
      return callback(undefined);
    }

    const effectiveParentId = parentId ?? this.getCurrentScope();
    const groupId = await this.startGroup(name, undefined, effectiveParentId);

    this.scopeStack.push(groupId);

    try {
      const result = await callback(groupId);
      this.endGroup(groupId, successStatus);
      return result;
    } catch (error) {
      this.endGroup(groupId, errorStatus);
      throw error;
    } finally {
      this.scopeStack.pop();
    }
  }

  /**
   * Get the current active scope (topmost group in the stack).
   * @returns The current group ID, or undefined if no active scope
   */
  getCurrentScope(): string | undefined {
    return this.scopeStack[this.scopeStack.length - 1];
  }

  /**
   * Temporarily set a specific group as active without pushing to stack.
   * Useful for operations that need to log to a specific group without
   * creating a nested scope.
   *
   * @param groupId Group ID to make active
   * @param callback Function to execute with the temporary scope
   * @returns Result of the callback
   */
  async withTemporaryScope<T>(
    groupId: string | undefined,
    callback: () => Promise<T>,
  ): Promise<T> {
    const previousScope = this.getCurrentScope();

    // Temporarily override the stack
    if (groupId !== undefined) {
      this.scopeStack.push(groupId);
    }

    try {
      return await callback();
    } finally {
      if (groupId !== undefined) {
        this.scopeStack.pop();
      }
    }
  }

  // Override log methods to automatically use current scope

  override debug(
    message: string,
    groupId?: string,
    messageType?: MessageType,
    data?: unknown,
  ): void {
    const effectiveGroupId = groupId ?? this.getCurrentScope();
    super.debug(message, effectiveGroupId, messageType, data);
  }

  override info(
    message: string,
    groupId?: string,
    messageType?: MessageType,
    data?: unknown,
  ): void {
    const effectiveGroupId = groupId ?? this.getCurrentScope();
    super.info(message, effectiveGroupId, messageType, data);
  }

  override warn(
    message: string,
    groupId?: string,
    messageType?: MessageType,
    data?: unknown,
  ): void {
    const effectiveGroupId = groupId ?? this.getCurrentScope();
    super.warn(message, effectiveGroupId, messageType, data);
  }

  override error(
    message: string,
    groupId?: string,
    messageType?: MessageType,
    data?: unknown,
  ): void {
    const effectiveGroupId = groupId ?? this.getCurrentScope();
    super.error(message, effectiveGroupId, messageType, data);
  }

  override fileList(files: unknown[], groupId?: string): void {
    const effectiveGroupId = groupId ?? this.getCurrentScope();
    super.fileList(files, effectiveGroupId);
  }

  override missingOutputs(info: unknown, groupId?: string): void {
    const effectiveGroupId = groupId ?? this.getCurrentScope();
    super.missingOutputs(info, effectiveGroupId);
  }

  override latexDiff(results: unknown[], groupId?: string): void {
    const effectiveGroupId = groupId ?? this.getCurrentScope();
    super.latexDiff(results, effectiveGroupId);
  }

  override statistics(stats: ExtendedTokenUsageStats, groupId?: string): void {
    const effectiveGroupId = groupId ?? this.getCurrentScope();
    super.statistics(stats, effectiveGroupId);
  }

  override userMessage(message: string, groupId?: string): void {
    const effectiveGroupId = groupId ?? this.getCurrentScope();
    super.userMessage(message, effectiveGroupId);
  }

  /**
   * Get the depth of the current scope stack.
   * Useful for debugging or conditional logic based on nesting level.
   */
  getScopeDepth(): number {
    return this.scopeStack.length;
  }

  /**
   * Check if currently within a group scope.
   */
  hasActiveScope(): boolean {
    return this.scopeStack.length > 0;
  }
}
