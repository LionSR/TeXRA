// Third-party imports
import { randomUUID } from 'crypto';

// Local imports - events
import type { ExtendedTokenUsageStats } from '@agent/types/UsageTypes';

// Internal imports
import {
  buildErrorLogData,
  type ErrorLogContext,
} from '@common/errors/sdkErrorUtils';
import { sleep } from '@utils/core';
import { SHORT_SLEEP_MS } from '@utils/config';
import { bus } from '@eventBus/ProgressEventBus';

// Local imports - log
import * as logger from './logUtils';
import { END_GROUP_STATUS, MESSAGE_TYPES } from './messageTypes';
import { shouldEmitToProgressView } from './filterUtils';

// Type imports
import type {
  EndGroupStatus,
  FileListEntry,
  MessageType,
} from './messageTypes';
import type { LogOptions } from './logOptions';

export interface LoggerScopeOptions {
  parentGroupId?: string;
  /**
   * When true, no progress-view group is created. The callback runs inside the
   * currently active group (or without grouping) while still inheriting the
   * logging context. Use this for instrumentation helpers that should not
   * clutter the UI with nested groups.
   */
  skip?: boolean;
  successStatus?: EndGroupStatus;
  errorStatus?: EndGroupStatus;
  id?: string;
}

export interface AgentLoggerStageOptions extends LoggerScopeOptions {
  parent?: AgentLogStage;
}

/**
 * Represents a logical logging scope that can wrap asynchronous work and
 * create nested child stages.
 *
 * - {@link run} executes the provided callback and automatically finalizes the
 *   stage with a success or error status when the promise settles.
 * - {@link within} runs the callback without ending the stage, allowing the
 *   caller to perform additional work (or register nested stages) before
 *   explicitly calling {@link end}. If the callback throws, the stage remains
 *   active until the caller finalizes it via {@link end}. Prefer calling
 *   {@link run} unless you need to coordinate several steps inside the same
 *   stage and can guarantee cleanup in a `finally` block.
 * - {@link end} manually finalizes the stage; calling it multiple times is a
 *   no-op after the first invocation.
 * - {@link stage} spawns a nested stage that inherits the current context.
 */
export interface AgentLogStage {
  readonly id?: string;
  /**
   * Runs work within the stage and automatically ends it once the promise
   * resolves or rejects.
   */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Executes work within the stage context without ending it. Useful when the
   * caller wants to manually control completion across several async steps.
   * Callers should typically wrap the invocation in a `try/finally` block that
   * calls {@link end} to avoid leaking the stage when the callback rejects.
   */
  within<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Explicitly finalizes the stage with the provided status. Safe to call
   * multiple times; subsequent calls are ignored.
   */
  end(status?: EndGroupStatus): void;
  /**
   * Creates a nested child stage beneath the current stage.
   */
  stage(
    label: string,
    options?: AgentLoggerStageOptions,
  ): Promise<AgentLogStage>;
}

class AgentLogStageHandle implements AgentLogStage {
  private ended = false;

  constructor(
    private readonly logger: AgentLogger,
    private readonly config: {
      id?: string;
      skip: boolean;
      successStatus: EndGroupStatus;
      errorStatus: EndGroupStatus;
      parentGroupId?: string;
    },
  ) {}

  get id(): string | undefined {
    return this.config.id;
  }

  async stage(
    label: string,
    options: AgentLoggerStageOptions = {},
  ): Promise<AgentLogStage> {
    return this.logger.stage(label, {
      ...options,
      parent: options.parent ?? this,
    });
  }

  async within<T>(fn: () => Promise<T>): Promise<T> {
    if (this.config.skip) {
      if (this.config.parentGroupId) {
        return this.logger.runWithGroup(this.config.parentGroupId, fn);
      }
      return this.logger.runWithinCurrentGroup(fn);
    }

    return this.logger.runWithGroup(this.config.id, fn);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const result = await this.within(fn);
      this.end(this.config.successStatus);
      return result;
    } catch (error) {
      this.end(this.config.errorStatus);
      throw error;
    }
  }

  end(status: EndGroupStatus = END_GROUP_STATUS.STOPPED): void {
    if (this.config.skip || !this.config.id || this.ended) {
      return;
    }

    this.ended = true;
    this.logger.endGroup(this.config.id, status);
  }
}

export interface AgentLogStreamOptions {
  groupId?: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
  progressViewEnabled?: boolean;
}

export interface AgentLogStream {
  append(text: string): void;
  finalize(finalText?: string): string;
}

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
  }

  /**
   * Log a debug message with options object.
   */
  debug(message: string, options: LogOptions = {}): void {
    logger.debug(this.channelId, message, {
      groupId: options.groupId,
      messageType: options.messageType,
      isAgent: this.isAgentLogger,
      data: options.data,
    });
  }

  /**
   * Log an info message with options object.
   */
  info(message: string, options: LogOptions = {}): void {
    logger.info(this.channelId, message, {
      groupId: options.groupId,
      messageType: options.messageType,
      isAgent: this.isAgentLogger,
      data: options.data,
    });
  }

  /**
   * Log a warning message with options object.
   */
  warn(message: string, options: LogOptions = {}): void {
    logger.warn(this.channelId, message, {
      groupId: options.groupId,
      messageType: options.messageType,
      isAgent: this.isAgentLogger,
      data: options.data,
    });
  }

  /**
   * Log an error message with options object.
   */
  error(message: string, options: LogOptions = {}): void {
    logger.error(this.channelId, message, {
      groupId: options.groupId,
      messageType: options.messageType,
      isAgent: this.isAgentLogger,
      data: options.data,
    });
  }

  /**
   * Log a structured error with consistent formatting.
   * Single source of truth for ERROR message type logging.
   *
   * @param message - Human-readable error description
   * @param err - The error object to format
   * @param context - Optional context (operation, model)
   * @param groupId - Optional group ID for progress view
   */
  logError(
    message: string,
    err: unknown,
    context?: ErrorLogContext,
    groupId?: string,
  ): void {
    const errorData = buildErrorLogData(err, context);
    this.error(message, {
      groupId,
      messageType: MESSAGE_TYPES.ERROR,
      data: errorData,
    });
  }

  /**
   * Log a progress status update.
   * Single source of truth for PROGRESS_STATUS message type logging.
   *
   * @param message - Status message
   * @param context - Optional context (operation, model)
   * @param groupId - Optional group ID for progress view
   */
  logProgress(
    message: string,
    context?: ErrorLogContext,
    groupId?: string,
  ): void {
    this.info(message, {
      groupId,
      messageType: MESSAGE_TYPES.PROGRESS_STATUS,
      data: context,
    });
  }

  /**
   * Log a structured error with pre-formatted error data.
   * Use this when error data is already structured (e.g., RetryErrorInfo).
   * For raw errors, use logError() instead.
   *
   * @param message - Human-readable error description
   * @param errorData - Pre-structured error data
   * @param groupId - Optional group ID for progress view
   */
  logErrorData(message: string, errorData: unknown, groupId?: string): void {
    this.error(message, {
      groupId,
      messageType: MESSAGE_TYPES.ERROR,
      data: errorData,
    });
  }

  /**
   * Log an internal/system message (hidden in normal mode, shown in debug).
   * Single source of truth for INTERNAL message type.
   */
  logInternal(message: string, groupId?: string): void {
    this.info(message, {
      groupId,
      messageType: MESSAGE_TYPES.INTERNAL,
    });
  }

  /**
   * Log an internal debug message (hidden in normal mode, shown in debug).
   * Single source of truth for INTERNAL message type at debug level.
   */
  debugInternal(message: string, groupId?: string): void {
    this.debug(message, {
      groupId,
      messageType: MESSAGE_TYPES.INTERNAL,
    });
  }

  /**
   * Log scratchpad/thinking content.
   * Single source of truth for SCRATCHPAD message type.
   */
  logScratchpad(content: string, groupId?: string): void {
    this.info(content, {
      groupId,
      messageType: MESSAGE_TYPES.SCRATCHPAD,
    });
  }

  /**
   * Log a list of files that were processed.
   * @param files - Array of FileListEntry objects conforming to FileListEntrySchema
   */
  fileList(files: FileListEntry[], groupId?: string): void {
    const summary = `Loaded ${files.length} file${files.length === 1 ? '' : 's'}`;
    this.info(summary, {
      groupId,
      messageType: MESSAGE_TYPES.FILE_LIST,
      data: files,
    });
  }

  /**
   * Log files being loaded for a specific category (input, reference, auxiliary, media).
   * Creates a FILE_LIST entry with a descriptive category label.
   * Empty arrays are handled gracefully (no-op).
   */
  logFileCategory(
    category: string,
    files: Array<Pick<FileListEntry, 'path'> & { ok?: boolean }>,
    groupId?: string,
  ): void {
    if (files.length === 0) {
      return;
    }

    // Use explicit === true check: only count files where existence was confirmed
    const loadedCount = files.filter((f) => f.ok === true).length;
    const summary = `Loading ${category} (${loadedCount}/${files.length})`;

    const entries: FileListEntry[] = files.map((f) => ({
      path: f.path,
      ok: f.ok === true,
      source: category,
      sourceDisplay: category,
    }));

    this.info(summary, {
      groupId,
      messageType: MESSAGE_TYPES.FILE_LIST,
      data: entries,
    });
  }

  /**
   * Log missing output information.
   */
  missingOutputs(info: unknown, groupId?: string): void {
    const missing =
      typeof info === 'object' && info !== null && 'missing' in info
        ? (info as { missing?: unknown[] }).missing
        : undefined;
    const count = missing?.length ?? 0;
    const summary = `${count} output file${count === 1 ? '' : 's'} missing`;
    this.info(summary, {
      groupId,
      messageType: MESSAGE_TYPES.MISSING_OUTPUTS,
      data: info,
    });
  }

  /**
   * Log latexdiff results.
   */
  latexDiff(results: unknown[], groupId?: string): void {
    const summary = `Latexdiff results: ${results.length}`;
    this.info(summary, {
      groupId,
      messageType: MESSAGE_TYPES.LATEXDIFF,
      data: results,
    });
  }

  /**
   * Log statistics information (only shown in debug mode).
   */
  statistics(stats: ExtendedTokenUsageStats, groupId?: string): void {
    const summary = `Usage - input: ${stats.inputTokens ?? 0}, output: ${stats.outputTokens ?? 0}`;
    this.info(summary, {
      groupId,
      messageType: MESSAGE_TYPES.STATISTICS,
      data: stats,
    });
  }

  /**
   * Log a user follow-up message.
   */
  userMessage(message: string, groupId?: string): void {
    this.info(message, {
      groupId,
      messageType: MESSAGE_TYPES.USER_MESSAGE,
    });
  }

  withCurrentGroup<T>(fn: (groupId: string) => T): T | undefined {
    const groupId = this.resolveActiveGroupId();
    if (!groupId) {
      return undefined;
    }

    return fn(groupId);
  }

  async runWithinCurrentGroup<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.runWithGroup(this.resolveActiveGroupId(), fn);
  }

  async runWithGroup<T>(
    groupId: string | undefined,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    if (!groupId) {
      return Promise.resolve(fn());
    }

    return logger.runWithGroupContext(
      this.channelId,
      groupId,
      this.isAgentLogger,
      async () => await fn(),
    );
  }

  async withScope<T>(
    groupName: string,
    fn: () => Promise<T>,
    options: LoggerScopeOptions = {},
  ): Promise<T> {
    const stage = await this.createStageHandle(groupName, options);
    return stage.run(fn);
  }

  async stage(
    groupName: string,
    options: AgentLoggerStageOptions = {},
  ): Promise<AgentLogStage> {
    return this.createStageHandle(groupName, options);
  }

  async withExistingGroup<T>(
    groupId: string,
    fn: () => Promise<T>,
    options: { label?: string } = {},
  ): Promise<T> {
    const stage = await this.stage(options.label ?? 'Existing group', {
      skip: true,
      parentGroupId: groupId,
      successStatus: 'stopped',
      errorStatus: 'error',
    });

    return stage.run(fn);
  }

  private async createStageHandle(
    groupName: string,
    options: AgentLoggerStageOptions | LoggerScopeOptions,
  ): Promise<AgentLogStageHandle> {
    const {
      skip = false,
      successStatus = 'stopped',
      errorStatus = 'error',
      parentGroupId,
      id,
      parent,
    } = options as AgentLoggerStageOptions;

    const resolvedParent =
      parent?.id ?? parentGroupId ?? this.resolveActiveGroupId();

    if (skip) {
      return new AgentLogStageHandle(this, {
        id: undefined,
        skip: true,
        successStatus,
        errorStatus,
        parentGroupId: resolvedParent,
      });
    }

    const groupId = await this.startGroup(groupName, id, resolvedParent);
    return new AgentLogStageHandle(this, {
      id: groupId,
      skip: false,
      successStatus,
      errorStatus,
      parentGroupId: resolvedParent,
    });
  }

  createStream(
    type: MessageType,
    options: AgentLogStreamOptions = {},
  ): AgentLogStream {
    const streamId = this.channelId;
    const id = randomUUID();
    let buffer = '';
    let isFirstUpdate = true;
    const level = options.level ?? 'info';
    const progressEnabled = options.progressViewEnabled ?? true;
    const groupId = options.groupId ?? this.resolveActiveGroupId();

    // Apply the same filtering logic as ProgressViewSink
    // This ensures debug mode and INTERNAL message filtering work consistently
    const shouldEmit =
      progressEnabled && shouldEmitToProgressView({ level, messageType: type });

    return {
      append: (text: string) => {
        if (!text) {
          return;
        }

        buffer += text;

        if (!shouldEmit) {
          return;
        }

        if (isFirstUpdate) {
          bus.emit('addLogMessage', {
            stream: streamId,
            logMessage: {
              id,
              text: buffer,
              level,
              timestamp: Date.now(),
              groupId,
              messageType: type,
            },
          });
          isFirstUpdate = false;
        } else {
          bus.emit('updateLogMessage', {
            stream: streamId,
            logMessage: {
              id,
              text: buffer,
              groupId,
              messageType: type,
            },
          });
        }
      },
      finalize: (finalText?: string) => {
        if (typeof finalText === 'string') {
          buffer = finalText;
        }

        if (!shouldEmit) {
          this.debug(`Final ${type} length: ${buffer.length}`, { groupId });
          return buffer;
        }

        if (isFirstUpdate) {
          bus.emit('addLogMessage', {
            stream: streamId,
            logMessage: {
              id,
              text: buffer,
              level,
              timestamp: Date.now(),
              groupId,
              messageType: type,
            },
          });
        } else {
          bus.emit('updateLogMessage', {
            stream: streamId,
            logMessage: {
              id,
              text: buffer,
              groupId,
              messageType: type,
            },
          });
        }

        this.debug(`Final ${type} length: ${buffer.length}`, { groupId });
        return buffer;
      },
    };
  }

  async startGroup(
    groupName: string,
    id?: string,
    parentGroupId?: string,
  ): Promise<string> {
    await sleep(SHORT_SLEEP_MS);
    return logger.startGroup(
      this.channelId,
      groupName,
      id,
      parentGroupId,
      this.isAgentLogger,
    );
  }

  endGroup(
    groupId: string,
    status: EndGroupStatus = END_GROUP_STATUS.STOPPED,
  ): void {
    logger.endGroup(this.channelId, groupId, status, this.isAgentLogger);
  }

  private resolveActiveGroupId(): string | undefined {
    return logger.getActiveGroupId(this.channelId, this.isAgentLogger);
  }
}
