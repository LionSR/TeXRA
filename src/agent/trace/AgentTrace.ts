/**
 * AgentTrace — agent-general SDK surface.
 *
 * Discriminated-event channel for an agent run. Any host (TeXRA, future
 * CLI, future SDK consumer) can subscribe with `subscribe()` and receive
 * every {@link AgentEvent}. Every other method on this interface is sugar
 * over `emit()` so the trace channel remains a single source of truth.
 *
 * TeXRA-specific helpers (`logError`/`logProgress`/`latexDiff`/
 * `userMessage`/etc.) are plain functions in `helpers.ts` and
 * `toolUseHelpers.ts` that operate on this interface — there is no host
 * subtype. SDK consumers program directly against `AgentTrace`.
 */
import type { RunOutcome, UpdateStreamUsagePayload } from '@shared/schemas';

import type {
  AgentEvent,
  ContextStateData,
  ResponseFinalizedEvent,
  StreamKind,
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
  /** Semantic stage kind consumed by host progress surfaces. */
  readonly kind?: 'run' | 'round' | 'phase' | 'session';
  /** Zero-based stage index, currently used for round stages. */
  readonly index?: number;
  /** Planned total count, when known, currently used for workflow rounds. */
  readonly total?: number;
  /** Physical workflow attempt that owns this stage, when applicable. */
  readonly attemptId?: string;
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
  /** Emit `stage.end` with the given outcome. Idempotent. */
  end(status?: RunOutcome): void;
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
  /** Stage id stamped on the start event; defaults to the active scope. */
  readonly stageId?: string;
  /**
   * When false, chunks are accumulated locally without emitting. `finalize`
   * still returns the buffered text. Useful for tests / off-progress paths.
   */
  readonly progressViewEnabled?: boolean;
  /**
   * Defer the `stream.start` emission until the first non-empty chunk (or a
   * finalize that carries text). Subscribers treat `stream.start` as "this
   * phase began" — e.g. thinking streams drive a "model is thinking" liveness
   * indicator — so a stream opened eagerly at request setup must not announce
   * a phase that may never happen. A deferred stream that ends without
   * content emits nothing at all.
   */
  readonly deferStart?: boolean;
  /**
   * Emit only the phase boundaries (`stream.start` / `stream.end`); chunk
   * text and the finalize text never reach subscribers (`finalize` still
   * returns the locally buffered text). Used when a phase should be visible
   * as liveness — "the model response has started" — while its content is
   * withheld, e.g. workflow runs that extract and log the output separately
   * instead of streaming it.
   */
  readonly phaseOnly?: boolean;
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
  /**
   * Host-specific category (e.g. TeXRA's MessageType taxonomy). Subscribers
   * may use it to pick a render style; agent-general consumers can ignore.
   */
  readonly messageType?: string;
  readonly verbose?: boolean;
  /**
   * Explicit stage override — bypasses the AsyncLocalStorage default for
   * callers that captured a group id earlier and want to attach this entry
   * to it.
   */
  readonly stageId?: string;
}

/** Options accepted by usage / contextState convenience emitters. */
export interface StagedEmitOptions {
  readonly stageId?: string;
}

export interface UsageEmitOptions extends StagedEmitOptions {
  readonly recordTranscript?: boolean;
}

/**
 * Agent-general SDK surface. Every method ultimately reduces to `emit()` so
 * the trace channel is a single source of truth. TeXRA-specific helpers are
 * plain functions over this interface (see `helpers.ts` / `toolUseHelpers.ts`).
 */
export interface AgentTrace {
  // ─── SSoT primitives ────────────────────────────────────────────────
  emit(event: AgentEvent): void;
  subscribe(subscriber: AgentTraceSubscriber): () => void;
  activeStageId(): string | undefined;

  // ─── Plain logging (sugar over emit) ────────────────────────────────
  debug(message: string, options?: LogOptions): void;
  info(message: string, options?: LogOptions): void;
  warn(message: string, options?: LogOptions): void;
  error(message: string, options?: LogOptions): void;

  // ─── First-class agent-general union arms ───────────────────────────
  usage(payload: UpdateStreamUsagePayload, options?: UsageEmitOptions): void;
  contextState(snapshot: ContextStateData, options?: StagedEmitOptions): void;
  toolStart(
    input: { logId: string; toolName: string; input: unknown },
    options?: StagedEmitOptions,
  ): void;
  toolEnd(
    input: { logId: string; status: ToolStatus; result?: unknown },
    options?: StagedEmitOptions,
  ): void;
  domain(input: DomainEventInput): void;
  /**
   * Authoritative final assistant text for the round that just ended the
   * turn (see {@link ResponseFinalizedEvent}). Call once, at the flow
   * boundary where the final text is decided, for both a mid-run turn
   * boundary and the terminal round.
   */
  responseFinalized(text: string, options?: StagedEmitOptions): void;

  // ─── Stage + stream handles ─────────────────────────────────────────
  openStage(label: string, options?: StageOptions): StageHandle;
  /**
   * Open a streaming message. `stream.start` marks the moment the phase the
   * stream represents actually began — emit it at the provider's phase
   * signal, or use `deferStart` when the first content chunk is the only
   * signal — so subscribers can surface liveness ("thinking…", "responding…")
   * from the start event alone.
   */
  openStream(kind: StreamKind, options?: StreamOptions): StreamHandle;
}
