/**
 * AgentLogger — TeXRA's structured-logging facade.
 *
 * Internally this class composes a {@link TraceEmitter} so every emission
 * passes through one channel: subscribers (console output + transcript
 * recorder) consume that channel; nothing writes to the store directly.
 *
 * The public API is preserved so existing callers (~100 files, ~800 method
 * calls) keep working unchanged while new code can reach the same channel
 * via `RunContext.trace`.
 */
import { randomUUID } from 'crypto';

import {
  TraceEmitter,
  type AgentTrace,
  type StageHandle,
  type StreamHandle,
} from '@agent/trace';
import { buildErrorLogData } from '@common/errors/sdkErrorUtils';
import {
  END_GROUP_STATUS,
  MESSAGE_TYPES,
  type ContextManagementData,
  type EndGroupStatus,
  type ErrorContext,
  type ExtendedTokenUsageStats,
  type FileListEntry,
  type LogLevel,
  type MessageType,
  type StreamTabId,
  type ToolUseLog,
} from '@shared/schemas';


import { attachConsoleSubscriber } from './consoleSubscriber';
import {
  attachTranscriptRecorder,
  type TranscriptRecorderHandle,
} from './TexraTranscriptRecorder';
import {
  getDefaultStreamLogStore,
  setDefaultStreamLogStore,
  type StreamLogStore,
} from './StreamLogStore';

interface LogOptions {
  groupId?: string;
  messageType?: MessageType;
  data?: unknown;
}

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
 * Mirror of the old AgentLogStage but powered by a {@link StageHandle}.
 * `skip` callers receive a passthrough handle that doesn't open a stage
 * but still propagates `parentGroupId` so nested log lines stay attached.
 */
class StageWrapper implements AgentLogStage {
  private ended = false;

  constructor(
    private readonly agentLogger: AgentLogger,
    private readonly handle: StageHandle | undefined,
    private readonly config: {
      skip: boolean;
      successStatus: EndGroupStatus;
      errorStatus: EndGroupStatus;
      parentGroupId?: string;
    },
  ) {}

  get id(): string | undefined {
    return this.handle?.id;
  }

  async stage(
    label: string,
    options: AgentLoggerStageOptions = {},
  ): Promise<AgentLogStage> {
    return this.agentLogger.stage(label, {
      ...options,
      parent: options.parent ?? this,
    });
  }

  async within<T>(fn: () => Promise<T>): Promise<T> {
    const targetId = this.config.skip ? this.config.parentGroupId : this.id;
    return this.agentLogger.runWithGroup(targetId, fn);
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
    if (this.config.skip || !this.handle || this.ended) return;
    this.ended = true;
    this.handle.end(status);
  }
}

export class AgentLogger {
  private static streamLogStore: StreamLogStore | undefined;
  private static activeFlushers = new Set<() => void>();

  static setStreamLogStore(store: StreamLogStore): void {
    setDefaultStreamLogStore(store);
    AgentLogger.streamLogStore = store;
  }

  static getStreamLogStore(): StreamLogStore {
    AgentLogger.streamLogStore ??= getDefaultStreamLogStore();
    return AgentLogger.streamLogStore;
  }

  /**
   * Drain any pending stream-chunk updates across every active logger.
   * Used by shutdown paths (progress view dispose, CLI exit) to make sure
   * in-flight throttled writes hit the store before the process tears down.
   */
  static flushPendingStreamUpdates(): void {
    for (const flush of [...AgentLogger.activeFlushers]) flush();
  }

  private readonly trace = new TraceEmitter();
  private readonly transcriptHandle?: TranscriptRecorderHandle;

  constructor(
    public readonly streamId: string,
    public readonly isAgentLogger = false,
  ) {
    attachConsoleSubscriber(this.trace, {
      channel: streamId,
      isAgent: isAgentLogger,
    });

    if (isAgentLogger) {
      this.transcriptHandle = attachTranscriptRecorder(
        this.trace,
        streamId as StreamTabId,
        AgentLogger.getStreamLogStore(),
      );
      AgentLogger.activeFlushers.add(this.transcriptHandle.flushPending);
    }
  }

  /**
   * Expose the underlying trace so SDK consumers can subscribe directly or
   * pass it through `RunContext.trace`.
   */
  getTrace(): AgentTrace {
    return this.trace;
  }

  /** Detach subscribers; used by shutdown paths in tests. */
  dispose(): void {
    if (this.transcriptHandle) {
      AgentLogger.activeFlushers.delete(this.transcriptHandle.flushPending);
      this.transcriptHandle.unsubscribe();
    }
  }

  // ─── Plain logging ───────────────────────────────────────────────────

  private log(level: LogLevel, message: string, options: LogOptions): void {
    this.trace.emit({
      type: 'log',
      level,
      message,
      data: options.data,
      messageType: options.messageType,
      // Carrying the explicit groupId through bypasses the AsyncLocalStorage
      // fallback inside emit() for callers that already resolved it.
      stageId: options.groupId,
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
    this.error(message, {
      groupId,
      messageType: MESSAGE_TYPES.ERROR,
      data: buildErrorLogData(err, context),
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
    this.trace.emit({
      type: 'context.state',
      inputTokens,
      contextWindow,
      stageId: groupId,
    });
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
    this.trace.emit({
      type: 'files.loaded',
      category,
      entries,
      stageId: groupId,
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
    this.trace.emit({
      type: 'usage',
      stats,
      stageId: groupId,
    });
  }

  userMessage(message: string): void {
    this.info(message, {
      messageType: MESSAGE_TYPES.USER_MESSAGE,
    });
  }

  // ─── Tool use ────────────────────────────────────────────────────────

  logToolUse(data: unknown, groupId?: string): void {
    this.emitToolUse(data, groupId);
  }

  emitToolUse(
    data: unknown,
    groupId?: string,
  ): { logId: string; groupId: string | undefined } {
    const logId = randomUUID();
    const resolvedGroupId = groupId ?? this.trace.activeStageId();
    const toolName =
      (data as { toolName?: string } | null)?.toolName ?? 'unknown';
    const input = (data as { input?: unknown } | null)?.input;
    this.trace.emit({
      type: 'tool.start',
      logId,
      toolName,
      input,
      stageId: resolvedGroupId,
    });
    return { logId, groupId: resolvedGroupId };
  }

  logToolUseStart(
    toolName: string,
    input: unknown,
    groupId?: string,
  ): { logId: string; groupId: string | undefined } {
    const ref = this.emitToolUse(
      { toolName, input, status: 'in_progress' } satisfies ToolUseLog,
      groupId,
    );
    this.debug(`Tool started: ${toolName}`, { groupId: ref.groupId });
    return ref;
  }

  updateToolUse(
    logId: string,
    toolUseLog: Omit<ToolUseLog, 'status'>,
    groupId?: string,
    status: ToolUseLog['status'] = 'completed',
  ): void {
    this.trace.emit({
      type: 'tool.end',
      logId,
      status,
      result: { ...toolUseLog },
      stageId: groupId,
    });
  }

  logWebSearch(data: unknown, groupId?: string): void {
    this.trace.emit({
      type: 'domain',
      key: 'webSearch',
      data,
      stageId: groupId,
    });
  }

  logWebFetch(data: unknown, groupId?: string): void {
    this.trace.emit({
      type: 'domain',
      key: 'webFetch',
      data,
      stageId: groupId,
    });
  }

  // ─── Stage scope helpers ─────────────────────────────────────────────

  withCurrentGroup<T>(fn: (groupId: string) => T): T | undefined {
    const groupId = this.trace.activeStageId();
    return groupId ? fn(groupId) : undefined;
  }

  async runWithinCurrentGroup<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.runWithGroup(this.trace.activeStageId(), fn);
  }

  async runWithGroup<T>(
    groupId: string | undefined,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    return this.trace.withStage(groupId, fn);
  }

  async stage(
    groupName: string,
    options: AgentLoggerStageOptions = {},
  ): Promise<AgentLogStage> {
    const {
      skip = false,
      successStatus = END_GROUP_STATUS.STOPPED,
      errorStatus = END_GROUP_STATUS.ERROR,
      parentGroupId,
      id,
      parent,
    } = options;

    const resolvedParent =
      parent?.id ?? parentGroupId ?? this.trace.activeStageId();

    if (skip) {
      return new StageWrapper(this, undefined, {
        skip: true,
        successStatus,
        errorStatus,
        parentGroupId: resolvedParent,
      });
    }

    const handle = this.trace.openStage(groupName, {
      id,
      parentId: resolvedParent,
      defaultStatus: successStatus,
    });
    return new StageWrapper(this, handle, {
      skip: false,
      successStatus,
      errorStatus,
      parentGroupId: resolvedParent,
    });
  }

  // ─── Streaming ───────────────────────────────────────────────────────

  createStream(
    type: MessageType,
    options: AgentLogStreamOptions = {},
  ): AgentLogStream {
    const level = options.level ?? 'info';
    const progressEnabled = options.progressViewEnabled ?? true;

    if (!progressEnabled) {
      // Buffer locally without emitting any events — preserves the legacy
      // "in-memory only" stream behavior used by callers that disable the
      // progress view sink.
      let buffer = '';
      return {
        append: (text: string) => {
          if (text) buffer += text;
        },
        finalize: (finalText?: string) => {
          if (typeof finalText === 'string') buffer = finalText;
          this.debug(`Final ${type} length: ${buffer.length}`, {
            groupId: options.groupId,
          });
          return buffer;
        },
      };
    }

    const handle: StreamHandle = this.runWithStreamScope(
      options.groupId,
      () => this.trace.openStream(type, { level }),
    );

    let buffer = '';
    return {
      append: (text: string) => {
        if (!text) return;
        buffer += text;
        handle.append(text);
      },
      finalize: (finalText?: string) => {
        if (typeof finalText === 'string') buffer = finalText;
        handle.finalize(finalText);
        this.debug(`Final ${type} length: ${buffer.length}`, {
          groupId: options.groupId,
        });
        return buffer;
      },
    };
  }

  /**
   * Open a stream while the given groupId is active so the `stream.start`
   * event carries the right stageId. Falls back to the current scope when
   * no override is provided.
   */
  private runWithStreamScope<T>(
    groupId: string | undefined,
    fn: () => T,
  ): T {
    if (!groupId || groupId === this.trace.activeStageId()) return fn();
    let result!: T;
    // withStage is async-storage based; we synchronously resolve fn() inside
    // the scope. The Promise wrapper isn't observable since openStream is
    // synchronous.
    void this.trace.withStage(groupId, () => {
      result = fn();
    });
    return result;
  }

  // ─── Group primitives ────────────────────────────────────────────────

  startGroup(groupName: string, id?: string, parentGroupId?: string): string {
    // Emit directly so an explicit `parentGroupId: undefined` produces a
    // ROOT group rather than inheriting the active stage. AgentLogger.stage
    // (the higher-level API) does its own resolution before calling
    // openStage, so the inherit-on-omit default belongs there, not here.
    const groupId = id ?? randomUUID();
    this.trace.emit({
      type: 'stage.start',
      id: groupId,
      label: groupName,
      parentId: parentGroupId,
    });
    return groupId;
  }

  endGroup(
    groupId: string,
    status: EndGroupStatus = END_GROUP_STATUS.STOPPED,
  ): void {
    this.trace.emit({ type: 'stage.end', id: groupId, status });
  }

  resolveActiveGroupId(): string | undefined {
    return this.trace.activeStageId();
  }
}
