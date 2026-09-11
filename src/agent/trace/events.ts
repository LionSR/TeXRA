/**
 * AgentEvent — discriminated union of everything that happens during a run.
 *
 * This is the agent-general SDK contract. Adding a new event type yields
 * an exhaustive-switch error in every subscriber until handled.
 *
 * The vocabulary is declared once, as Zod, in
 * `src/shared/schemas/sessionEvent.ts` (the trace arms come from
 * `traceEvent.ts` and are spliced in there). Every arm below is that
 * declaration minus the aggregate qualification: the aggregate is the run,
 * and `runEventDraft` adds it back at publication. The one arm the session
 * plane does not carry is the transient `stream.chunk` (never a session row;
 * text travels through the session graph). The terminal `run.end` row is
 * not a trace arm: the storage finalizer writes it once, and the in-memory
 * `ResultEvent` below is that row named by its run.
 *
 * Host-specific events that don't belong in the core union (TeXRA's
 * file-list payloads, latexdiff, scratchpad, etc.) use the `domain`
 * escape hatch with a host-chosen `key`.
 */
import type { RunId, SessionEventDraft } from '@shared/schemas';

/** One session arm as the trace carries it; distributive over `T`. */
type TraceArm<T extends SessionEventDraft['type']> = T extends unknown
  ? Omit<Extract<SessionEventDraft, { type: T }>, 'aggregateId'>
  : never;

/**
 * StreamKind identifies what a streaming message represents. Subscribers
 * key on it for render decisions. Generic string so host taxonomies
 * (TeXRA's MessageType) plug in without coupling the SDK.
 */
export type StreamKind = string;

/** Context-state snapshot emitted around context-management checkpoints. */
export type ContextStateData = Pick<
  TraceArm<'context.state'>,
  'inputTokens' | 'contextWindow'
>;

/** One turn's token usage, keyed by the run it belongs to: the trace's own
 *  run, or a child whose spend a parent's usage map keys by that child's id. */
export type UsageReport = Pick<TraceArm<'usage'>, 'runId' | 'usage'>;

/**
 * Stream lifecycle phase change emitted by the session-owned status machine.
 * Not an {@link AgentEvent} arm: status travels only as a canonical session
 * fact on the session's event plane (`SessionHandle.publishStatus`). The type
 * stays here because the trace package owns the event vocabulary the fact
 * reuses.
 */
export type StatusEvent = TraceArm<'status'> & { readonly runId: RunId };

/**
 * The terminal fact as the runtime hands it to in-process consumers
 * (`RunHandle.result`, `SessionHandle.onResult`): the `run.end` row named by
 * its run. Not an {@link AgentEvent} arm: the row is written once by the
 * storage finalizer (`finalizeRun`), never emitted on a trace.
 */
export type ResultEvent = TraceArm<'run.end'> & { readonly runId: RunId };

/**
 * Chunk appended to an open stream. Transient: `runEventDraft` returns null
 * for it and the session graph carries the text instead, so it has no
 * session arm to derive from.
 */
interface StreamChunkEvent {
  readonly type: 'stream.chunk';
  readonly id: string;
  readonly text: string;
  readonly stageId?: string;
}

/**
 * Authoritative final assistant text for the round that just ended the
 * turn — decided once at the flow boundary where `assembly.lastResponse` is
 * set (after `extractResponse`'s replacement-rule cleanup runs), and carried
 * as data from there rather than re-derived downstream. Fires at every
 * mid-run turn boundary (the tool-use loop pausing to wait for the next user
 * message), not only the terminal round, so a subscriber never has to guess
 * whether the run is "really" done (#7086).
 *
 * The round's own MODEL_RESPONSE stream (when the response actually
 * streamed) writes raw provider chunks in real time, before replacement
 * rules run — so its persisted text can trivially differ from this event's
 * text (e.g. a literal vs. a replaced LaTeX symbol). Subscribers reconcile by
 * updating that stream's entry to this text instead of a caller having to
 * prove the two already match.
 */
export type ResponseFinalizedEvent = TraceArm<'response.finalized'>;

/** Discriminated union of every event the SDK surface emits. */
export type AgentEvent =
  | TraceArm<
      | 'log'
      | 'stage.start'
      | 'stage.end'
      | 'tool.start'
      | 'tool.end'
      | 'workflow.plan'
      | 'workflow.call'
      | 'skills.snapshot'
      | 'usage'
      | 'conversation.progress'
      | 'updateTodos'
      | 'updatePlan'
      | 'addOutputFiles'
      | 'updateMissingOutputs'
      | 'updateCompileFailures'
      | 'context.state'
      | 'stream.start'
      | 'stream.end'
      | 'response.finalized'
      | 'domain'
    >
  /** Mutable persisted run config changed after run.start, e.g. model switch. */
  | (TraceArm<'run.config'> & { readonly runId: RunId })
  | StreamChunkEvent;
