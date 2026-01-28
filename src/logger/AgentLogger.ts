import { randomUUID } from 'crypto';

import {
  END_GROUP_STATUS,
  MESSAGE_TYPES,
  type ContextManagementData,
  type EndGroupStatus,
  type ErrorContext,
  type ExtendedTokenUsageStats,
  type FileListEntry,
  type MessageType,
} from '@shared/schemas';
import { buildErrorLogData } from '@common/errors/sdkErrorUtils';
import { delay } from '@utils/core';
import { SHORT_SLEEP_MS } from '@utils/config';
import { bus } from '@eventBus/ProgressEventBus';

import { getEmitFilter } from './filterUtils';
import * as logger from './logUtils';
import type { LogOptions } from './logOptions';

export interface LoggerScopeOptions {
  parentGroupId?: string;
  /** When true, no progress-view group is created (for instrumentation helpers) */
  skip?: boolean;
  successStatus?: EndGroupStatus;
  errorStatus?: EndGroupStatus;
  id?: string;
}

export interface AgentLoggerStageOptions extends LoggerScopeOptions {
  parent?: AgentLogStage;
}

export interface AgentLogStage {
  readonly id?: string;
  run<T>(fn: () => Promise<T>): Promise<T>;
  within<T>(fn: () => Promise<T>): Promise<T>;
  end(status?: EndGroupStatus): void;
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
    const groupId = this.config.skip
      ? this.config.parentGroupId
      : this.config.id;
    return this.logger.runWithGroup(groupId, fn);
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

export class AgentLogger {
  constructor(
    public readonly streamId: string,
    public readonly isAgentLogger = false,
  ) {
    logger.initialize(streamId, isAgentLogger);
  }

  private log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    options: LogOptions = {},
  ): void {
    logger[level](this.streamId, message, {
      groupId: options.groupId ?? this.resolveActiveGroupId(),
      messageType: options.messageType,
      isAgent: this.isAgentLogger,
      data: options.data,
    });
  }

  debug(message: string, options: LogOptions = {}): void {
    this.log('debug', message, options);
  }

  info(message: string, options: LogOptions = {}): void {
    this.log('info', message, options);
  }

  warn(message: string, options: LogOptions = {}): void {
    this.log('warn', message, options);
  }

  error(message: string, options: LogOptions = {}): void {
    this.log('error', message, options);
  }

  logError(
    message: string,
    err: unknown,
    context?: ErrorContext,
    groupId?: string,
  ): void {
    const errorData = buildErrorLogData(err, context);
    this.error(message, {
      groupId,
      messageType: MESSAGE_TYPES.ERROR,
      data: errorData,
    });
  }

  logProgress(message: string, context?: ErrorContext, groupId?: string): void {
    this.info(message, {
      groupId,
      messageType: MESSAGE_TYPES.PROGRESS_STATUS,
      data: context,
    });
  }

  logErrorData(message: string, errorData: unknown, groupId?: string): void {
    this.error(message, {
      groupId,
      messageType: MESSAGE_TYPES.ERROR,
      data: errorData,
    });
  }

  logInternal(message: string, groupId?: string): void {
    this.info(message, {
      groupId,
      messageType: MESSAGE_TYPES.INTERNAL,
    });
  }

  debugInternal(message: string, groupId?: string): void {
    this.debug(message, {
      groupId,
      messageType: MESSAGE_TYPES.INTERNAL,
    });
  }

  logScratchpad(content: string, groupId?: string): void {
    this.info(content, {
      groupId,
      messageType: MESSAGE_TYPES.SCRATCHPAD,
    });
  }

  logContextManagement(
    message: string,
    data?: ContextManagementData,
    groupId?: string,
  ): void {
    this.info(message, {
      groupId,
      messageType: MESSAGE_TYPES.CONTEXT_MANAGEMENT,
      data,
    });
  }

  logContextState(
    inputTokens: number,
    contextWindow: number,
    groupId?: string,
  ): void {
    const utilizationPercent = (inputTokens / contextWindow) * 100;
    this.info(
      `Context: ${inputTokens}/${contextWindow} tokens (${utilizationPercent.toFixed(1)}%)`,
      {
        groupId,
        messageType: MESSAGE_TYPES.CONTEXT_STATE,
        data: { inputTokens, contextWindow, utilizationPercent },
      },
    );
  }

  fileList(files: FileListEntry[], groupId?: string): void {
    this.info(`Loaded ${files.length} file${files.length === 1 ? '' : 's'}`, {
      groupId,
      messageType: MESSAGE_TYPES.FILE_LIST,
      data: files,
    });
  }

  logFileCategory(
    category: string,
    files: Array<Pick<FileListEntry, 'path'> & { ok?: boolean }>,
    groupId?: string,
  ): void {
    if (files.length === 0) return;

    const entries: FileListEntry[] = files.map((f) => ({
      path: f.path,
      ok: f.ok === true,
      source: category,
      sourceDisplay: category,
    }));
    const loadedCount = entries.filter((e) => e.ok).length;
    this.info(`Loading ${category} (${loadedCount}/${files.length})`, {
      groupId,
      messageType: MESSAGE_TYPES.FILE_LIST,
      data: entries,
    });
  }

  missingOutputs(info: unknown, groupId?: string): void {
    const missing = (info as { missing?: unknown[] } | null)?.missing;
    const count = Array.isArray(missing) ? missing.length : 0;
    this.info(`${count} output file${count === 1 ? '' : 's'} missing`, {
      groupId,
      messageType: MESSAGE_TYPES.MISSING_OUTPUTS,
      data: info,
    });
  }

  latexDiff(results: unknown[], groupId?: string): void {
    this.info(`Latexdiff results: ${results.length}`, {
      groupId,
      messageType: MESSAGE_TYPES.LATEXDIFF,
      data: results,
    });
  }

  statistics(stats: ExtendedTokenUsageStats, groupId?: string): void {
    this.info(
      `Usage - input: ${stats.inputTokens ?? 0}, output: ${stats.outputTokens ?? 0}`,
      {
        groupId,
        messageType: MESSAGE_TYPES.STATISTICS,
        data: stats,
      },
    );
  }

  userMessage(message: string, groupId?: string): void {
    this.info(message, { groupId, messageType: MESSAGE_TYPES.USER_MESSAGE });
  }

  logToolUse(data: unknown, groupId?: string): void {
    this.info('', { groupId, messageType: MESSAGE_TYPES.TOOL_USE, data });
  }

  logWebSearch(data: unknown, groupId?: string): void {
    this.info('', { groupId, messageType: MESSAGE_TYPES.WEB_SEARCH, data });
  }

  withCurrentGroup<T>(fn: (groupId: string) => T): T | undefined {
    const groupId = this.resolveActiveGroupId();
    return groupId ? fn(groupId) : undefined;
  }

  async runWithinCurrentGroup<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.runWithGroup(this.resolveActiveGroupId(), fn);
  }

  async runWithGroup<T>(
    groupId: string | undefined,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    if (!groupId) {
      return fn();
    }

    return logger.runWithGroupContext(
      this.streamId,
      groupId,
      this.isAgentLogger,
      fn,
    );
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
      id,
      parent,
    } = options;

    const resolvedParent =
      parent?.id ?? parentGroupId ?? this.resolveActiveGroupId();
    const groupId = skip
      ? undefined
      : await this.startGroup(groupName, id, resolvedParent);

    return new AgentLogStageHandle(this, {
      id: groupId,
      skip,
      successStatus,
      errorStatus,
      parentGroupId: resolvedParent,
    });
  }

  createStream(
    type: MessageType,
    options: AgentLogStreamOptions = {},
  ): AgentLogStream {
    const streamId = this.streamId;
    const id = randomUUID();
    const level = options.level ?? 'info';
    const groupId = options.groupId ?? this.resolveActiveGroupId();
    const progressEnabled = options.progressViewEnabled ?? true;

    const { shouldEmit, debugMode } = progressEnabled
      ? getEmitFilter({ level, messageType: type })
      : { shouldEmit: false, debugMode: false };

    let buffer = '';
    let messageCreated = false;

    return {
      append: (text: string) => {
        if (!text) return;
        buffer += text;
        if (!shouldEmit) return;

        if (messageCreated) {
          bus.emit('updateLogMessage', {
            streamId,
            logMessage: { id, text: buffer, groupId, messageType: type },
          });
        } else {
          bus.emit('addLogMessage', {
            streamId,
            logMessage: {
              id,
              text: buffer,
              level,
              timestamp: Date.now(),
              groupId,
              messageType: type,
              verbose: debugMode,
            },
          });
          messageCreated = true;
        }
      },
      finalize: (finalText?: string) => {
        if (typeof finalText === 'string') buffer = finalText;

        if (shouldEmit) {
          const event = messageCreated ? 'updateLogMessage' : 'addLogMessage';
          bus.emit(event, {
            streamId,
            logMessage: messageCreated
              ? { id, text: buffer, groupId, messageType: type }
              : {
                  id,
                  text: buffer,
                  level,
                  timestamp: Date.now(),
                  groupId,
                  messageType: type,
                  verbose: debugMode,
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
    await delay(SHORT_SLEEP_MS);
    return logger.startGroup(
      this.streamId,
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
    logger.endGroup(this.streamId, groupId, status, this.isAgentLogger);
  }

  private resolveActiveGroupId(): string | undefined {
    return logger.getActiveGroupId(this.streamId, this.isAgentLogger);
  }
}
