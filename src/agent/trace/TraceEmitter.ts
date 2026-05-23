/**
 * Default in-process implementation of {@link AgentTrace}.
 *
 * Responsibilities at the emit boundary (one place, not many):
 *   - stamp `stageId` from the AsyncLocalStorage scope
 *   - fan out to subscribers
 *   - swallow per-subscriber exceptions so one bad sink can't break the run
 *
 * Every sugar method on AgentTrace (debug/info/warn/error, logError,
 * openStage, openStream, usage, etc.) reduces to a single `emit()` call.
 * Adding a new event arm forces an exhaustive-switch error in every
 * subscriber and nothing else.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { buildErrorLogData } from '@common/errors/sdkErrorUtils';
import {
  END_GROUP_STATUS,
  MESSAGE_TYPES,
  type ContextManagementData,
  type EndGroupStatus,
  type ErrorContext,
  type FileListEntry,
} from '@shared/schemas';

import type {
  AgentEvent,
  ContextStateData,
  FilesLoadedEvent,
  StreamKind,
  TokenUsageStats,
  ToolStatus,
} from './events';
import type {
  AgentTrace,
  AgentTraceSubscriber,
  DomainEventInput,
  LogOptions,
  StagedEmitOptions,
  StageHandle,
  StageOptions,
  StreamHandle,
  StreamOptions,
  ToolStartRef,
} from './AgentTrace';

const stageScope = new AsyncLocalStorage<string[]>();

function currentStageStack(): string[] {
  return stageScope.getStore() ?? [];
}

export class TraceEmitter implements AgentTrace {
  private readonly subscribers = new Set<AgentTraceSubscriber>();

  // ─── SSoT primitives ───────────────────────────────────────────────

  subscribe(subscriber: AgentTraceSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  emit(event: AgentEvent): void {
    // Single resolve point — stage stamp wins from the event itself if
    // the caller supplied one; otherwise fall back to the active scope.
    const stamped: AgentEvent =
      event.stageId !== undefined
        ? event
        : ({ ...event, stageId: currentStageStack().at(-1) } as AgentEvent);

    for (const sub of this.subscribers) {
      try {
        sub(stamped);
      } catch {
        // A misbehaving subscriber must not break the run.
      }
    }
  }

  activeStageId(): string | undefined {
    return currentStageStack().at(-1);
  }

  withStage<T>(
    stageId: string | undefined,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    if (!stageId) return Promise.resolve(fn());
    const nextStack = [...currentStageStack(), stageId];
    return stageScope.run(nextStack, () => Promise.resolve(fn()));
  }

  // ─── Plain logging ─────────────────────────────────────────────────

  debug(message: string, options: LogOptions = {}): void {
    this.emitLog('debug', message, options);
  }

  info(message: string, options: LogOptions = {}): void {
    this.emitLog('info', message, options);
  }

  warn(message: string, options: LogOptions = {}): void {
    this.emitLog('warn', message, options);
  }

  error(message: string, options: LogOptions = {}): void {
    this.emitLog('error', message, options);
  }

  private emitLog(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    options: LogOptions,
  ): void {
    this.emit({
      type: 'log',
      level,
      message,
      data: options.data,
      messageType: options.messageType,
      verbose: options.verbose,
      stageId: options.stageId,
    });
  }

  // ─── Domain log-event sugar ────────────────────────────────────────

  logError(
    message: string,
    err: unknown,
    context?: ErrorContext,
    groupId?: string,
  ): void {
    this.error(message, {
      messageType: MESSAGE_TYPES.ERROR,
      data: buildErrorLogData(err, context),
      stageId: groupId,
    });
  }

  logProgress(message: string, context?: ErrorContext, groupId?: string): void {
    this.info(message, {
      messageType: MESSAGE_TYPES.PROGRESS_STATUS,
      data: context,
      stageId: groupId,
    });
  }

  logErrorData(message: string, errorData: unknown, groupId?: string): void {
    this.error(message, {
      messageType: MESSAGE_TYPES.ERROR,
      data: errorData,
      stageId: groupId,
    });
  }

  logInternal(message: string, groupId?: string): void {
    this.info(message, {
      messageType: MESSAGE_TYPES.INTERNAL,
      stageId: groupId,
    });
  }

  debugInternal(message: string, groupId?: string): void {
    this.debug(message, {
      messageType: MESSAGE_TYPES.INTERNAL,
      stageId: groupId,
    });
  }

  logScratchpad(content: string, groupId?: string): void {
    this.info(content, {
      messageType: MESSAGE_TYPES.SCRATCHPAD,
      stageId: groupId,
    });
  }

  logContextManagement(
    message: string,
    data?: ContextManagementData,
    groupId?: string,
  ): void {
    this.info(message, {
      messageType: MESSAGE_TYPES.CONTEXT_MANAGEMENT,
      data,
      stageId: groupId,
    });
  }

  logContextState(
    inputTokens: number,
    contextWindow: number,
    groupId?: string,
  ): void {
    this.emit({
      type: 'context.state',
      inputTokens,
      contextWindow,
      stageId: groupId,
    });
  }

  missingOutputs(info: unknown, groupId?: string): void {
    const missing = (info as { missing?: unknown[] } | null)?.missing;
    const count = Array.isArray(missing) ? missing.length : 0;
    this.info(`${count} output file${count === 1 ? '' : 's'} missing`, {
      messageType: MESSAGE_TYPES.MISSING_OUTPUTS,
      data: info,
      stageId: groupId,
    });
  }

  latexDiff(results: unknown[], groupId?: string): void {
    this.info(`Latexdiff results: ${results.length}`, {
      messageType: MESSAGE_TYPES.LATEXDIFF,
      data: results,
      stageId: groupId,
    });
  }

  userMessage(message: string): void {
    this.info(message, { messageType: MESSAGE_TYPES.USER_MESSAGE });
  }

  // ─── Structured emitters ───────────────────────────────────────────

  usage(stats: TokenUsageStats, options: StagedEmitOptions = {}): void {
    this.emit({ type: 'usage', stats, stageId: options.stageId });
  }

  contextState(
    snapshot: ContextStateData,
    options: StagedEmitOptions = {},
  ): void {
    this.emit({
      type: 'context.state',
      inputTokens: snapshot.inputTokens,
      contextWindow: snapshot.contextWindow,
      stageId: options.stageId,
    });
  }

  filesLoaded(
    input: Omit<FilesLoadedEvent, 'type' | 'stageId'>,
    options: StagedEmitOptions = {},
  ): void {
    this.emit({
      type: 'files.loaded',
      category: input.category,
      entries: input.entries,
      stageId: options.stageId,
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
    this.filesLoaded({ category, entries }, { stageId: groupId });
  }

  toolStart(
    input: { logId: string; toolName: string; input: unknown },
    options: StagedEmitOptions = {},
  ): void {
    this.emit({
      type: 'tool.start',
      logId: input.logId,
      toolName: input.toolName,
      input: input.input,
      stageId: options.stageId,
    });
  }

  toolEnd(
    input: { logId: string; status: ToolStatus; result?: unknown },
    options: StagedEmitOptions = {},
  ): void {
    this.emit({
      type: 'tool.end',
      logId: input.logId,
      status: input.status,
      result: input.result,
      stageId: options.stageId,
    });
  }

  emitToolUse(data: unknown, groupId?: string): ToolStartRef {
    const logId = randomUUID();
    const resolvedGroupId = groupId ?? this.activeStageId();
    const toolName =
      (data as { toolName?: string } | null)?.toolName ?? 'unknown';
    const input = (data as { input?: unknown } | null)?.input;
    this.toolStart({ logId, toolName, input }, { stageId: resolvedGroupId });
    return { logId, groupId: resolvedGroupId };
  }

  logToolUseStart(
    toolName: string,
    input: unknown,
    groupId?: string,
  ): ToolStartRef {
    const ref = this.emitToolUse({ toolName, input }, groupId);
    this.debug(`Tool started: ${toolName}`, { stageId: ref.groupId });
    return ref;
  }

  updateToolUse(
    logId: string,
    toolUseLog: { toolName?: string; input?: unknown; output?: unknown },
    groupId?: string,
    status: ToolStatus = 'completed',
  ): void {
    this.toolEnd(
      { logId, status, result: { ...toolUseLog } },
      { stageId: groupId },
    );
  }

  logWebSearch(data: unknown, groupId?: string): void {
    this.domain({ key: 'webSearch', data, stageId: groupId });
  }

  logWebFetch(data: unknown, groupId?: string): void {
    this.domain({ key: 'webFetch', data, stageId: groupId });
  }

  domain(input: DomainEventInput): void {
    this.emit({
      type: 'domain',
      key: input.key,
      data: input.data,
      text: input.text,
      stageId: input.stageId,
    });
  }

  // ─── Stages ────────────────────────────────────────────────────────

  openStage(label: string, options: StageOptions = {}): StageHandle {
    const defaultStatus = options.defaultStatus ?? END_GROUP_STATUS.STOPPED;
    const parentId =
      options.parent?.id ?? options.parentId ?? this.activeStageId();

    if (options.skip) {
      return new SkippedStageHandle(this, parentId);
    }

    const id = options.id ?? randomUUID();
    this.emit({ type: 'stage.start', id, label, parentId });
    return new StageHandleImpl(this, id, defaultStatus);
  }

  startGroup(name: string, id?: string, parentGroupId?: string): string {
    // Direct emit — explicit `parentGroupId: undefined` produces a ROOT
    // group rather than inheriting the active stage. openStage's higher-
    // level API has the inherit-on-omit fallback; this primitive does not.
    const groupId = id ?? randomUUID();
    this.emit({
      type: 'stage.start',
      id: groupId,
      label: name,
      parentId: parentGroupId,
    });
    return groupId;
  }

  endGroup(
    id: string,
    status: EndGroupStatus = END_GROUP_STATUS.STOPPED,
  ): void {
    this.emit({ type: 'stage.end', id, status });
  }

  // ─── Streams ───────────────────────────────────────────────────────

  openStream(kind: StreamKind, options: StreamOptions = {}): StreamHandle {
    const id = options.id ?? randomUUID();
    const progressEnabled = options.progressViewEnabled ?? true;

    if (!progressEnabled) {
      // Local-only buffering — chunks never emit. `finalize` returns the
      // text but nothing reaches subscribers.
      return new BufferOnlyStreamHandle(this, id, kind);
    }

    // Open inside the explicit stage scope so the start event carries the
    // right stageId without forcing the caller to await.
    if (options.stageId && options.stageId !== this.activeStageId()) {
      const nextStack = [...currentStageStack(), options.stageId];
      let handle!: StreamHandle;
      stageScope.run(nextStack, () => {
        this.emit({ type: 'stream.start', id, kind });
        handle = new StreamHandleImpl(this, id, kind);
      });
      return handle;
    }

    this.emit({ type: 'stream.start', id, kind });
    return new StreamHandleImpl(this, id, kind);
  }
}

class StageHandleImpl implements StageHandle {
  private ended = false;

  constructor(
    private readonly trace: TraceEmitter,
    readonly id: string,
    private readonly defaultStatus: EndGroupStatus,
  ) {}

  end(status?: EndGroupStatus): void {
    if (this.ended) return;
    this.ended = true;
    this.trace.emit({
      type: 'stage.end',
      id: this.id,
      status: status ?? this.defaultStatus,
    });
  }

  async within<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.trace.withStage(this.id, fn);
  }

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    try {
      const result = await this.within(fn);
      this.end(this.defaultStatus);
      return result;
    } catch (err) {
      this.end(END_GROUP_STATUS.ERROR);
      throw err;
    }
  }

  child(label: string, options: StageOptions = {}): StageHandle {
    return this.trace.openStage(label, { ...options, parent: this });
  }
}

/** Stage handle used when `skip: true` — propagates parent context but emits nothing. */
class SkippedStageHandle implements StageHandle {
  readonly id: string | undefined;

  constructor(
    private readonly trace: TraceEmitter,
    private readonly parentId: string | undefined,
  ) {
    this.id = undefined;
  }

  end(_status?: EndGroupStatus): void {
    // Skipped stages never opened a group; nothing to end.
  }

  async within<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.trace.withStage(this.parentId, fn);
  }

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.within(fn);
  }

  child(label: string, options: StageOptions = {}): StageHandle {
    return this.trace.openStage(label, {
      ...options,
      parentId: options.parentId ?? this.parentId,
    });
  }
}

class StreamHandleImpl implements StreamHandle {
  private buffer = '';
  private finalized = false;

  constructor(
    private readonly trace: TraceEmitter,
    readonly id: string,
    private readonly kind: StreamKind,
  ) {}

  append(text: string): void {
    if (this.finalized || !text) return;
    this.buffer += text;
    this.trace.emit({ type: 'stream.chunk', id: this.id, text });
  }

  finalize(finalText?: string): string {
    if (this.finalized) return this.buffer;
    this.finalized = true;
    if (typeof finalText === 'string') this.buffer = finalText;
    this.trace.emit({
      type: 'stream.end',
      id: this.id,
      finalText: typeof finalText === 'string' ? finalText : undefined,
    });
    this.trace.debug(`Final ${this.kind} length: ${this.buffer.length}`);
    return this.buffer;
  }
}

/**
 * Local-buffer-only stream — used when `progressViewEnabled: false`.
 * Chunks never reach subscribers; `finalize` returns the accumulated text
 * so callers can still read it back.
 */
class BufferOnlyStreamHandle implements StreamHandle {
  private buffer = '';
  private finalized = false;

  constructor(
    private readonly trace: TraceEmitter,
    readonly id: string,
    private readonly kind: StreamKind,
  ) {}

  append(text: string): void {
    if (this.finalized || !text) return;
    this.buffer += text;
  }

  finalize(finalText?: string): string {
    if (this.finalized) return this.buffer;
    this.finalized = true;
    if (typeof finalText === 'string') this.buffer = finalText;
    this.trace.debug(`Final ${this.kind} length: ${this.buffer.length}`);
    return this.buffer;
  }
}
