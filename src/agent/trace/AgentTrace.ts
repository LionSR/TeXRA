/**
 * AgentTrace — agent-general SDK surface.
 *
 * Discriminated-event channel for an agent run. Any host (TeXRA, future
 * CLI, future SDK consumer) can subscribe with `subscribe()` and receive
 * every {@link AgentEvent}. Every other method on this interface is sugar
 * over `emit()` so the trace channel remains a single source of truth.
 *
 * TeXRA-specific helpers (`logSdkError`/`logProgressStatus`/
 * `logUserMessage`/etc.) are plain functions in `helpers.ts` and
 * `toolUseHelpers.ts` that operate on this interface — there is no host
 * subtype. SDK consumers program directly against `AgentTrace`.
 */
import type { RunOutcome } from '@shared/schemas';

import type { AgentEvent, StreamKind } from './events';

/** A sink the trace was built with: it receives every event emitted on the
 *  trace until the trace closes. */
export type AgentTraceSink = (event: AgentEvent) => void;

/** Options accepted by `openStage`. */
export interface StageOptions {
  /** Semantic stage kind consumed by host progress surfaces. */
  readonly kind?: 'run' | 'round' | 'phase' | 'session';
  /** Zero-based stage index, currently used for round stages. */
  readonly index?: number;
  /** Planned total count, when known, currently used for workflow rounds. */
  readonly total?: number;
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
   * Stage to attach this entry to, for callers that captured a group id
   * earlier. Without one the entry belongs to no stage.
   */
  readonly stageId?: string;
}

/**
 * Agent-general SDK surface. Every method ultimately reduces to `emit()` so
 * the trace channel is a single source of truth. TeXRA-specific helpers are
 * plain functions over this interface (see `helpers.ts` / `toolUseHelpers.ts`).
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
  openRun(kind: StreamKind, options?: StreamOptions): StreamHandle;
}
