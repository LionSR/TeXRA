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
 * Host-specific facts that don't belong in the core union (TeXRA's
 * file-list payloads, latexdiff, missing outputs, etc.) ride a log arm:
 * `trace.info(text, { messageType, data })`.
 */
import type { RunId, SessionEventDraft } from '@shared/schemas';

/** One session arm as the trace carries it; distributive over `T`. */
type TraceArm<T extends SessionEventDraft['type']> = T extends unknown
  ? Omit<Extract<SessionEventDraft, { type: T }>, 'aggregateId'>
  : never;

/**
 * The terminal fact as the runtime hands it to in-process consumers
 * (`SessionHandle.onResult`): the `run.end` row named by
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
      | 'usage'
      | 'conversation.progress'
      | 'run.fact'
      | 'context.state'
      | 'stream.start'
      | 'stream.end'
      | 'response.finalized'
    >
  /** Mutable persisted run config changed after run.start. */
  | (TraceArm<'run.config'> & { readonly runId: RunId })
  | StreamChunkEvent;
