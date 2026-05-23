/**
 * AgentTrace — single discriminated-event channel for an agent run.
 *
 * SDK consumers subscribe with `subscribe()` and receive every AgentEvent
 * (logs, stages, tools, streams, etc.). Every other method on this
 * interface is sugar over `emit()` — they exist to make TeXRA's internal
 * call sites readable, but they don't add new emission channels.
 *
 * Pure pass-through aliases that AgentLogger historically exposed
 * (`statistics`, `fileList`, `createStream`, `logToolUse`, `resolveActiveGroupId`,
 * `withCurrentGroup`, async `stage(...)`, etc.) have been removed. Callers
 * use the canonical names directly.
 */
import type {
  ContextManagementData,
  EndGroupStatus,
  ErrorContext,
  FileListEntry,
  MessageType,
} from '@shared/schemas';

import type {
  AgentEvent,
  ContextStateData,
  FilesLoadedEvent,
  LogEvent,
  StreamKind,
  TokenUsageStats,
  ToolStatus,
} from './events';

/** Subscriber receives every event emitted on the trace. */
export type AgentTraceSubscriber = (event: AgentEvent) => void;

/** Options accepted by `openStage`. */
export interface StageOptions {
  /** Explicit id; otherwise a fresh one is generated. */
  readonly id?: string;
  /** Parent stage id; otherwise the active stage from the run scope. */
  readonly parentId?: string;
  /**
   * Status to emit at stage.end when no explicit status is supplied.
   * Defaults to `stopped`.
   */
  readonly defaultStatus?: EndGroupStatus;
  /**
   * Skip stage creation but propagate parent context to nested calls.
   * `handle.id` is undefined; `handle.within(fn)` runs `fn` in the parent
   * scope. Used by output sub-stages that don't need their own group.
   */
  readonly skip?: boolean;
  /** Parent handle for nested-stage chains. */
  readonly parent?: StageHandle;
}

/** Handle returned by `openStage` — wraps a stage with run/within/end ops. */
export interface StageHandle {
  /** Stage id; undefined for skipped (passthrough) stages. */
  readonly id: string | undefined;
  /** Emit `stage.end` with the given status. Idempotent. */
  end(status?: EndGroupStatus): void;
  /** Run `fn` with this stage as the active stamp. */
  within<T>(fn: () => Promise<T> | T): Promise<T>;
  /** `within(fn)` + auto-end on success/failure with success/error status. */
  run<T>(fn: () => Promise<T> | T): Promise<T>;
  /** Open a nested stage parented to this one. */
  child(label: string, options?: StageOptions): StageHandle;
}

/** Options accepted by `openStream`. */
export interface StreamOptions {
  /** Explicit id; otherwise a fresh one is generated. */
  readonly id?: string;
  /** Level used for the underlying log entries. */
  readonly level?: LogEvent['level'];
  /** Stage id stamped on the start event; defaults to the active scope. */
  readonly stageId?: string;
  /**
   * When false, chunks are accumulated locally without emitting. `finalize`
   * still returns the buffered text. Useful for tests / off-progress paths.
   */
  readonly progressViewEnabled?: boolean;
}

/** Handle returned by `openStream` — append chunks then finalize. */
export interface StreamHandle {
  readonly id: string;
  /** Append a chunk of text; emits `stream.chunk`. */
  append(text: string): void;
  /**
   * Close the stream; emits `stream.end`. Idempotent. Returns the buffered
   * content so callers can inspect the final text without separately
   * tracking it.
   */
  finalize(finalText?: string): string;
}

/** Domain event input shared between `domain()` and emit helpers. */
export interface DomainEventInput {
  readonly key: string;
  readonly data?: unknown;
  readonly text?: string;
  readonly stageId?: string;
}

/** Sugar passed to debug/info/warn/error. */
export interface LogOptions {
  readonly data?: unknown;
  readonly messageType?: MessageType;
  readonly verbose?: boolean;
  /**
   * Explicit stage override — bypasses the AsyncLocalStorage default for
   * callers that captured a group id earlier and want to attach this entry
   * to it.
   */
  readonly stageId?: string;
}

/** Options accepted by usage / contextState / filesLoaded convenience emitters. */
export interface StagedEmitOptions {
  readonly stageId?: string;
}

/** Payload returned by tool-start helpers. */
export interface ToolStartRef {
  readonly logId: string;
  readonly groupId: string | undefined;
}

/**
 * Core SDK surface. Every method ultimately reduces to `emit()` so the
 * trace channel is a single source of truth.
 */
export interface AgentTrace {
  // ─── SSoT primitives ────────────────────────────────────────────────
  emit(event: AgentEvent): void;
  subscribe(subscriber: AgentTraceSubscriber): () => void;
  activeStageId(): string | undefined;
  withStage<T>(
    stageId: string | undefined,
    fn: () => Promise<T> | T,
  ): Promise<T>;

  // ─── Plain logging (sugar over emit) ────────────────────────────────
  debug(message: string, options?: LogOptions): void;
  info(message: string, options?: LogOptions): void;
  warn(message: string, options?: LogOptions): void;
  error(message: string, options?: LogOptions): void;

  // ─── Domain log-event sugar (each emits a single `log` event) ───────
  logError(
    message: string,
    err: unknown,
    context?: ErrorContext,
    groupId?: string,
  ): void;
  logProgress(message: string, context?: ErrorContext, groupId?: string): void;
  logErrorData(message: string, errorData: unknown, groupId?: string): void;
  logInternal(message: string, groupId?: string): void;
  debugInternal(message: string, groupId?: string): void;
  logScratchpad(content: string, groupId?: string): void;
  logContextManagement(
    message: string,
    data?: ContextManagementData,
    groupId?: string,
  ): void;
  logContextState(
    inputTokens: number,
    contextWindow: number,
    groupId?: string,
  ): void;
  missingOutputs(info: unknown, groupId?: string): void;
  latexDiff(results: unknown[], groupId?: string): void;
  userMessage(message: string): void;

  // ─── Structured first-class union arms ──────────────────────────────
  usage(stats: TokenUsageStats, options?: StagedEmitOptions): void;
  contextState(snapshot: ContextStateData, options?: StagedEmitOptions): void;
  filesLoaded(
    input: Omit<FilesLoadedEvent, 'type' | 'stageId'>,
    options?: StagedEmitOptions,
  ): void;
  logFileCategory(
    category: string,
    files: Array<Pick<FileListEntry, 'path'> & { ok?: boolean }>,
    groupId?: string,
  ): void;
  toolStart(
    input: { logId: string; toolName: string; input: unknown },
    options?: StagedEmitOptions,
  ): void;
  toolEnd(
    input: { logId: string; status: ToolStatus; result?: unknown },
    options?: StagedEmitOptions,
  ): void;
  emitToolUse(data: unknown, groupId?: string): ToolStartRef;
  logToolUseStart(
    toolName: string,
    input: unknown,
    groupId?: string,
  ): ToolStartRef;
  updateToolUse(
    logId: string,
    toolUseLog: { toolName?: string; input?: unknown; output?: unknown },
    groupId?: string,
    status?: ToolStatus,
  ): void;
  logWebSearch(data: unknown, groupId?: string): void;
  logWebFetch(data: unknown, groupId?: string): void;
  domain(input: DomainEventInput): void;

  // ─── Stage + stream handles ─────────────────────────────────────────
  openStage(label: string, options?: StageOptions): StageHandle;
  openStream(kind: StreamKind, options?: StreamOptions): StreamHandle;
  startGroup(name: string, id?: string, parentGroupId?: string): string;
  endGroup(id: string, status?: EndGroupStatus): void;
}

/**
 * Legacy alias — `AgentLogStage` was the type exposed by the removed
 * `AgentLogger`. Still imported from a handful of files; kept here while
 * the rename to `StageHandle` proceeds.
 */
export type AgentLogStage = StageHandle;
export type AgentLogStream = StreamHandle;
