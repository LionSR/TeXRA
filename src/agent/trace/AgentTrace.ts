/**
 * AgentTrace — single discriminated-event channel for an agent run.
 *
 * SDK consumers subscribe and receive every AgentEvent (logs, stages, tools,
 * streams, etc.). Sugar methods (debug/info/warn/error) and stateful sub-
 * handles (openStage/openStream) are thin wrappers over `emit()` so there is
 * one source of truth for what crossed the run boundary.
 *
 * Plain RunLogger remains available on RunContext; it now forwards into the
 * trace channel so a single subscriber sees everything.
 */
import type { EndGroupStatus, MessageType } from '@shared/schemas';

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
}

/** Handle returned by `openStage` — wraps a stage with run/within/end ops. */
export interface StageHandle {
  readonly id: string;
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
}

/** Handle returned by `openStream` — append chunks then finalize. */
export interface StreamHandle {
  readonly id: string;
  /** Append a chunk of text; emits `stream.chunk`. */
  append(text: string): void;
  /** Close the stream; emits `stream.end`. Idempotent. */
  finalize(finalText?: string): void;
}

/** Options used by emit-level domain events. */
export interface DomainEventInput {
  readonly key: string;
  readonly data?: unknown;
  readonly text?: string;
}

/** Sugar passed to debug/info/warn/error. */
export interface LogOptions {
  readonly data?: unknown;
  readonly messageType?: MessageType;
  readonly verbose?: boolean;
}

/**
 * Core SDK surface. Every domain method ultimately reduces to `emit()` so the
 * trace channel is a single source of truth.
 */
export interface AgentTrace {
  emit(event: AgentEvent): void;
  subscribe(subscriber: AgentTraceSubscriber): () => void;

  // Sugar — pure delegation to emit():
  debug(message: string, options?: LogOptions): void;
  info(message: string, options?: LogOptions): void;
  warn(message: string, options?: LogOptions): void;
  error(message: string, options?: LogOptions): void;

  // Stage / stream handles — stateful but still emit into the same channel:
  openStage(label: string, options?: StageOptions): StageHandle;
  openStream(kind: StreamKind, options?: StreamOptions): StreamHandle;

  // Domain-specific helpers (TeXRA escape hatch):
  domain(input: DomainEventInput): void;

  // Convenience emitters for first-class union arms:
  usage(stats: TokenUsageStats): void;
  contextState(snapshot: ContextStateData): void;
  filesLoaded(input: Omit<FilesLoadedEvent, 'type' | 'stageId'>): void;
  toolStart(input: {
    logId: string;
    toolName: string;
    input: unknown;
  }): void;
  toolEnd(input: { logId: string; status: ToolStatus; result?: unknown }): void;

  /**
   * Active stage id stamped onto events emitted within the current
   * AsyncLocalStorage scope. Subscribers may also read `event.stageId`.
   */
  activeStageId(): string | undefined;

  /**
   * Run `fn` with `stageId` pushed onto the active stage stack. Used to
   * resume a stage opened earlier (deferred tools, externally created
   * groups). Passthrough when `stageId` is undefined.
   */
  withStage<T>(
    stageId: string | undefined,
    fn: () => Promise<T> | T,
  ): Promise<T>;
}
