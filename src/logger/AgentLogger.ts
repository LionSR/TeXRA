// Third-party imports
import { randomUUID } from 'crypto';
import { encode as encodeHtml } from 'he';

// Local imports - events
import { bus } from '@eventBus/ProgressEventBus';

// Local imports - log
import * as logger from './logUtils';
import type { MessageType } from './messageTypes';
import { MESSAGE_TYPES } from './messageTypes';
import type { ExtendedTokenUsageStats } from '@agent/types/UsageTypes';
import { sleep } from '@utils/helpers';
import { SHORT_SLEEP_MS } from '@utils/config';

export interface LoggerScopeOptions {
  parentGroupId?: string;
  skip?: boolean;
  successStatus?: 'stopped' | 'error';
  errorStatus?: 'stopped' | 'error';
  id?: string;
}

export interface AgentLoggerStageOptions extends LoggerScopeOptions {
  parent?: AgentLogStage;
}

export interface AgentLogStage {
  readonly id?: string;
  run<T>(fn: () => Promise<T>): Promise<T>;
  within<T>(fn: () => Promise<T>): Promise<T>;
  end(status?: 'stopped' | 'error'): void;
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
      successStatus: 'stopped' | 'error';
      errorStatus: 'stopped' | 'error';
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
      parent: this,
    });
  }

  async within<T>(fn: () => Promise<T>): Promise<T> {
    if (this.config.skip) {
      const parentGroup = this.config.parentGroupId;
      if (parentGroup) {
        return this.logger.withActiveGroup(parentGroup, fn);
      }
      return fn();
    }

    return this.logger.withActiveGroup(this.config.id, fn);
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

  end(status: 'stopped' | 'error' = 'stopped'): void {
    if (this.config.skip || !this.config.id || this.ended) {
      return;
    }

    this.logger.endGroup(this.config.id, status);
    this.ended = true;
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

  async withScope<T>(
    groupName: string,
    fn: () => Promise<T>,
    options: LoggerScopeOptions = {},
  ): Promise<T> {
    const {
      skip = false,
      successStatus = 'stopped',
      errorStatus = 'error',
      parentGroupId,
      id,
    } = options;

    if (skip) {
      if (parentGroupId) {
        return this.withActiveGroup(parentGroupId, fn);
      }
      return fn();
    }

    const resolvedParent = parentGroupId ?? this.getActiveGroupId();
    const groupId = await this.startGroup(groupName, id, resolvedParent);

    try {
      const result = await fn();
      this.endGroup(groupId, successStatus);
      return result;
    } catch (error) {
      this.endGroup(groupId, errorStatus);
      throw error;
    }
  }

  async stage(
    groupName: string,
    options: AgentLoggerStageOptions = {},
  ): Promise<AgentLogStage> {
    const {
      skip = false,
      successStatus = 'stopped',
      errorStatus = 'error',
      parentGroupId,
      parent,
      id,
    } = options;

    const resolvedParent =
      parent?.id ?? parentGroupId ?? this.getActiveGroupId();

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
    const groupId = options.groupId ?? this.getActiveGroupId();

    return {
      append: (text: string) => {
        if (!text) {
          return;
        }

        buffer += text;

        if (!progressEnabled) {
          return;
        }

        if (isFirstUpdate) {
          bus.emit('addLogMessage', {
            stream: streamId,
            logMessage: {
              id,
              text: encodeHtml(buffer),
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
              text: encodeHtml(buffer),
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

        if (!progressEnabled) {
          this.debug(`Final ${type} length: ${buffer.length}`, groupId);
          return buffer;
        }

        if (isFirstUpdate) {
          bus.emit('addLogMessage', {
            stream: streamId,
            logMessage: {
              id,
              text: encodeHtml(buffer),
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
              text: encodeHtml(buffer),
              groupId,
              messageType: type,
            },
          });
        }

        this.debug(`Final ${type} length: ${buffer.length}`, groupId);
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

  endGroup(groupId: string, status: 'error' | 'stopped' = 'stopped'): void {
    logger.endGroup(this.channelId, groupId, status, this.isAgentLogger);
  }

  getActiveGroupId(): string | undefined {
    return logger.getActiveGroupId(this.channelId, this.isAgentLogger);
  }

  setActiveGroupId(groupId: string | undefined): void {
    logger.setActiveGroupId(this.channelId, groupId, this.isAgentLogger);
  }

  async withActiveGroup<T>(
    groupId: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.getActiveGroupId();
    this.setActiveGroupId(groupId);
    try {
      return await fn();
    } finally {
      this.setActiveGroupId(previous);
    }
  }
}
