/**
 * AgentTrace — agent-general SDK surface.
 *
 * Discriminated-event channel for an agent run. Every {@link AgentEvent}
 * reaches the sinks the trace was built with ({@link AgentTraceSink}). Every other method on this interface is sugar
 * over `emit()` so the trace channel remains a single source of truth.
 *
 * App-specific helpers (`logSdkError`/`logProgressStatus`/
 * `logUserMessage`/etc.) are plain functions in `helpers.ts` that operate on
 * this interface — there is no host subtype. SDK consumers program directly
 * against `AgentTrace`.
 */
import type { MessageType, RunOutcome, ToolUseLog } from '@shared/schemas';

import type { AgentEvent } from './events';

/** A sink the trace was built with: it receives every event emitted on the
 *  trace until the trace closes. */
export type AgentTraceSink = (event: AgentEvent) => void;

/** Options accepted by `openStage`. */
export interface StageOptions {
  /** Semantic stage kind consumed by host progress surfaces. */
  readonly kind?: 'run' | 'session';
  /** Parent handle for nested stages; without one the stage opens as a root. */
  readonly parent?: StageHandle;
}

/** Handle returned by `openStage` — wraps a stage with end/child ops. */
export interface StageHandle {
  /** Stage id. */
  readonly id: string | undefined;
  /** Emit `stage.end` with the given outcome. Idempotent. */
  end(status?: RunOutcome): void;
  /** Open a nested stage parented to this one. */
  child(label: string, options?: StageOptions): StageHandle;
}

/** Options accepted by `openRun`. */
export interface StreamOptions {
  /**
   * Defer the `stream.start` emission until the first non-empty chunk (or a
   * finalize that carries text). Subscribers treat `stream.start` as "this
   * phase began" — e.g. thinking streams drive a "model is thinking" liveness
   * indicator — so a stream opened eagerly at request setup must not announce
   * a phase that may never happen. A deferred stream that ends without
   * content emits nothing at all.
   */
  readonly deferStart?: boolean;
}

/** Handle returned by `openRun` — append chunks then finalize. */
export interface StreamHandle {
  readonly id: string;
  /** Append a chunk of text; emits `stream.chunk`. */
  append(text: string): void;
  /**
   * Close the stream and emit its complete text in `stream.end`. Idempotent.
   * Returns that text to the caller as well.
   */
  finalize(finalText?: string): string;
}

/**
 * Handle returned by `openToolCard`: one tool call's card, for a caller that
 * runs the call outside the run loop (an external agent's own tools).
 */
export interface ToolCardHandle {
  /** The log the card last showed. */
  readonly log: ToolUseLog;
  /**
   * Show the call's latest log: an `in_progress` status keeps the card open,
   * any other closes it, and a log without a status closes it as completed.
   */
  update(log: ToolUseLog): void;
  /**
   * Close the card as failed if it is still open, keeping what it last
   * showed: the caller's turn ended before the call reported. A closed card
   * is left as it closed.
   */
  failIfOpen(): void;
}

/** Sugar passed to debug/info/warn/error. */
export interface LogOptions {
  readonly data?: unknown;
  /** The row's category; subscribers pick a render style from it. */
  readonly messageType?: MessageType;
  /**
   * Stage to attach this entry to, for callers that captured a group id
   * earlier. Without one the entry belongs to no stage.
   */
  readonly stageId?: string;
}

/**
 * Agent-general SDK surface. Every method ultimately reduces to `emit()` so
 * the trace channel is a single source of truth. App-specific helpers are
 * plain functions over this interface (see `helpers.ts`).
 */
export interface AgentTrace {
  // ─── SSoT primitives ────────────────────────────────────────────────
  emit(event: AgentEvent): void;

  // ─── Plain logging (sugar over emit) ────────────────────────────────
  debug(message: string, options?: LogOptions): void;
  info(message: string, options?: LogOptions): void;
  warn(message: string, options?: LogOptions): void;
  error(message: string, options?: LogOptions): void;

  // ─── Stage + stream handles ─────────────────────────────────────────
  openStage(label: string, options?: StageOptions): StageHandle;
  /**
   * Open a streaming message. `stream.start` marks the moment the phase the
   * stream represents actually began — emit it at the provider's phase
   * signal, or use `deferStart` when the first content chunk is the only
   * signal — so subscribers can surface liveness ("thinking…", "responding…")
   * from the start event alone.
   */
  openRun(kind: MessageType, options?: StreamOptions): StreamHandle;
  /**
   * Open a tool call's card with its first log (`tool.start`). A log whose
   * status is already terminal opens and closes the card at once; one without
   * a status, or `in_progress`, leaves it open for `update`.
   */
  openToolCard(log: ToolUseLog): ToolCardHandle;
}
