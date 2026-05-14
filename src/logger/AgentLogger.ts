import { randomUUID } from 'crypto';

import { buildErrorLogData } from '@common/errors/sdkErrorUtils';
import {
  END_GROUP_STATUS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type ContextManagementData,
  type EndGroupStatus,
  type ErrorContext,
  type ExtendedTokenUsageStats,
  type FileListEntry,
  type LogLevel,
  type MessageType,
  type StreamLogEntry,
  type ToolUseLog,
} from '@shared/schemas';
import { serializeError } from '@utils/core';

import { getEmitFilter } from './filterUtils';
import * as logger from './logUtils';
import {
  getDefaultStreamLogStore,
  setDefaultStreamLogStore,
  type StreamLogStore,
} from './StreamLogStore';
import type { LogOptions } from './logOptions';

const STREAM_UPDATE_THROTTLE_MS = 50;

export interface LoggerScopeOptions {
  parentGroupId?: string;
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
  private static streamLogStore: StreamLogStore | undefined;
  private static pendingStreamFlushers = new Set<() => void>();

  static setStreamLogStore(store: StreamLogStore): void {
    setDefaultStreamLogStore(store);
    AgentLogger.streamLogStore = store;
  }

  static getStreamLogStore(): StreamLogStore {
    AgentLogger.streamLogStore ??= getDefaultStreamLogStore();
    return AgentLogger.streamLogStore;
  }

  static flushPendingStreamUpdates(): void {
    for (const flush of [...AgentLogger.pendingStreamFlushers]) {
      flush();
    }
  }

  private get store(): StreamLogStore {
    return AgentLogger.getStreamLogStore();
  }

  constructor(
    public readonly streamId: string,
    public readonly isAgentLogger = false,
  ) {
    logger.initialize(streamId, isAgentLogger);
  }

  private appendToStore(
    level: LogLevel,
    messageType: MessageType,
    entry: Omit<StreamLogEntry, 'seqNo' | 'type' | 'level' | 'messageType'> &
      Partial<Pick<StreamLogEntry, 'type'>>,
  ): StreamLogEntry | undefined {
    if (!this.isAgentLogger) return undefined;

    const { shouldEmit, debugMode } = getEmitFilter({ level, messageType });
    if (!shouldEmit) return undefined;

    return this.store.append(this.streamId, {
      id: entry.id,
      type: entry.type ?? STREAM_LOG_ENTRY_TYPES.LOG,
      level,
      timestamp: entry.timestamp,
      groupId: entry.groupId,
      messageType,
      text: entry.text,
      data: entry.data,
      verbose: entry.verbose ?? debugMode,
    });
  }

  private updateStore(
    id: string,
    patch: Partial<Omit<StreamLogEntry, 'id' | 'seqNo'>>,
  ): StreamLogEntry | undefined {
    if (!this.isAgentLogger) return undefined;
    return this.store.update(this.streamId, id, patch);
  }

  private log(
    level: LogLevel,
    message: string,
    options: LogOptions = {},
  ): void {
    const messageType = options.messageType ?? MESSAGE_TYPES.DEFAULT;
    const groupId = options.groupId ?? this.resolveActiveGroupId();
    const data =
      options.data instanceof Error
        ? serializeError(options.data)
        : options.data;

    logger[level](this.streamId, message, {
      groupId,
      messageType,
      isAgent: this.isAgentLogger,
      data,
    });

    this.appendToStore(level, messageType, {
      id: randomUUID(),
      timestamp: Date.now(),
      groupId,
      text: message,
      data,
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
    this.emitContextState(inputTokens, contextWindow, groupId);
  }

  emitContextState(
    inputTokens: number,
    contextWindow: number,
    groupId?: string,
  ): void {
    const utilizationPercent = (inputTokens / contextWindow) * 100;
    const resolvedGroupId = groupId ?? this.resolveActiveGroupId();
    this.log(
      'info',
      `Context: ${inputTokens}/${contextWindow} tokens (${utilizationPercent.toFixed(1)}%)`,
      {
        groupId: resolvedGroupId,
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
    this.info(
      `Loading ${category} (${files.filter((f) => f.ok).length}/${files.length})`,
      { groupId, messageType: MESSAGE_TYPES.FILE_LIST, data: entries },
    );
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

  userMessage(message: string): void {
    this.log('info', message, {
      messageType: MESSAGE_TYPES.USER_MESSAGE,
    });
  }

  logToolUse(data: unknown, groupId?: string): void {
    this.emitToolUse(data, groupId);
  }

  emitToolUse(
    data: unknown,
    groupId?: string,
  ): { logId: string; groupId: string | undefined } {
    const id = randomUUID();
    const resolvedGroupId = groupId ?? this.resolveActiveGroupId();
    this.appendToStore('info', MESSAGE_TYPES.TOOL_USE, {
      id,
      timestamp: Date.now(),
      groupId: resolvedGroupId,
      data,
    });
    return { logId: id, groupId: resolvedGroupId };
  }

  logToolUseStart(
    toolName: string,
    input: unknown,
    groupId?: string,
  ): { logId: string; groupId: string | undefined } {
    const resolvedGroupId = groupId ?? this.resolveActiveGroupId();
    this.debug(`Tool started: ${toolName}`, { groupId: resolvedGroupId });
    return this.emitToolUse(
      { toolName, input, status: 'in_progress' } satisfies ToolUseLog,
      resolvedGroupId,
    );
  }

  updateToolUse(
    logId: string,
    toolUseLog: Omit<ToolUseLog, 'status'>,
    groupId?: string,
    status: ToolUseLog['status'] = 'completed',
  ): void {
    this.updateStore(logId, {
      groupId,
      messageType: MESSAGE_TYPES.TOOL_USE,
      data: { ...toolUseLog, status } satisfies ToolUseLog,
    });
  }

  logWebSearch(data: unknown, groupId?: string): void {
    this.emitWebSearch(data, groupId);
  }

  emitWebSearch(data: unknown, groupId?: string): void {
    this.appendToStore('info', MESSAGE_TYPES.WEB_SEARCH, {
      id: randomUUID(),
      timestamp: Date.now(),
      groupId: groupId ?? this.resolveActiveGroupId(),
      data,
    });
  }

  logWebFetch(data: unknown, groupId?: string): void {
    this.appendToStore('info', MESSAGE_TYPES.WEB_FETCH, {
      id: randomUUID(),
      timestamp: Date.now(),
      groupId: groupId ?? this.resolveActiveGroupId(),
      data,
    });
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
      : this.startGroup(groupName, id, resolvedParent);

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
    const id = randomUUID();
    const level = options.level ?? 'info';
    const groupId = options.groupId ?? this.resolveActiveGroupId();
    const progressEnabled = options.progressViewEnabled ?? true;

    let buffer = '';
    let pendingChunks: string[] = [];
    let created = false;
    let storeEnabled = progressEnabled;
    let updateTimer: ReturnType<typeof setTimeout> | null = null;

    const registerPendingFlush = (): void => {
      AgentLogger.pendingStreamFlushers.add(flushPendingUpdate);
    };

    const unregisterPendingFlush = (): void => {
      AgentLogger.pendingStreamFlushers.delete(flushPendingUpdate);
    };

    const materializePending = (): void => {
      if (pendingChunks.length === 0) return;
      buffer += pendingChunks.join('');
      pendingChunks = [];
    };

    const emitNow = (): void => {
      materializePending();
      if (!storeEnabled) return;

      if (!created) {
        const appended = this.appendToStore(level, type, {
          id,
          timestamp: Date.now(),
          groupId,
          text: buffer,
        });
        created = !!appended;
        if (!created) storeEnabled = false;
        return;
      }

      this.updateStore(id, { text: buffer });
    };

    const scheduleUpdate = (): void => {
      if (updateTimer) return;
      updateTimer = setTimeout(() => {
        updateTimer = null;
        emitNow();
        unregisterPendingFlush();
      }, STREAM_UPDATE_THROTTLE_MS);
      registerPendingFlush();
    };

    const flushPendingUpdate = (): void => {
      if (updateTimer) {
        clearTimeout(updateTimer);
        updateTimer = null;
      }
      emitNow();
      unregisterPendingFlush();
    };

    return {
      append: (text: string) => {
        if (!text) return;
        pendingChunks.push(text);
        if (!storeEnabled) return;
        if (!created) {
          emitNow();
        } else {
          scheduleUpdate();
        }
      },
      finalize: (finalText?: string) => {
        if (typeof finalText === 'string') {
          buffer = finalText;
          pendingChunks = [];
        }
        flushPendingUpdate();
        this.debug(`Final ${type} length: ${buffer.length}`, { groupId });
        return buffer;
      },
    };
  }

  startGroup(groupName: string, id?: string, parentGroupId?: string): string {
    const groupId = id ?? randomUUID();

    this.appendToStore('info', MESSAGE_TYPES.DEFAULT, {
      id: groupId,
      type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
      timestamp: Date.now(),
      groupId: parentGroupId,
      text: groupName,
      data: { status: 'running' },
    });

    return groupId;
  }

  endGroup(
    groupId: string,
    status: EndGroupStatus = END_GROUP_STATUS.STOPPED,
  ): void {
    this.updateStore(groupId, {
      type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
      data: { status, endTime: Date.now() },
    });
  }

  resolveActiveGroupId(): string | undefined {
    return logger.getActiveGroupId(this.streamId, this.isAgentLogger);
  }
}
