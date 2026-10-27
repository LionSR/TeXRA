/**
 * AgentEvent — discriminated union of everything that happens during a run.
 *
 * This is the agent-general SDK contract. Adding a new event type yields
 * an exhaustive-switch error in every subscriber until handled.
 *
 * The vocabulary is declared once, as Effect Schema, in
 * the session event schema (the trace arms are spliced in there). Every arm below is that
 * declaration minus the aggregate qualification: the aggregate is the run,
 * and `runEventDraft` adds it back at publication. The one arm the session
 * plane does not carry is the transient `stream.chunk` (never a session row;
 * text travels through the session graph). The terminal `run.end` row is
 * not a trace arm: the storage finalizer writes it once, and the in-memory
 * `ResultEvent` below is that row named by its run.
 *
 * Display text rides a log arm (`trace.info(text, { messageType, data })`)
 * with a core message type; a plugin's own facts are `plugin.fact` rows
 * (`ToolResult.facts`), never a log payload.
 */
import type { RunId, SessionEventDraft } from '@shared/schemas';

/** One session arm as the trace carries it, distributive over `T`: an
 *  {@link AgentEvent} arm, or the `run.end` a {@link ResultEvent} names. A
 *  row the run's state is folded from is never one: the trace is the
 *  display door, and those rows commit through the run's cell
 *  (`runEventDraft`, typed to an unfolded draft, refuses any other). */
export type TraceArm<
  T extends Exclude<AgentEvent, StreamChunkEvent>['type'] | 'run.end',
> = T extends unknown
  ? Omit<Extract<SessionEventDraft, { type: T }>, 'aggregateId'>
  : never;

/**
 * The terminal fact as the runtime hands it to in-process consumers
 * (`presentTerminalResult`): the `run.end` row named by
 * its run. Not an {@link AgentEvent} arm: the row is written once by the
 * storage finalizer (`finalizeRun`), never emitted on a trace.
 */
export type ResultEvent = TraceArm<'run.end'> & { readonly runId: RunId };

/**
 * Chunk appended to an open stream. Transient: `runEventDraft` returns null
 * for it and the session graph carries the text instead, so it has no
 * session arm to derive from.
 */
export interface StreamChunkEvent {
  readonly type: 'stream.chunk';
  readonly id: string;
  readonly text: string;
}

/** Discriminated union of every event the SDK surface emits. */
export type AgentEvent =
  | TraceArm<
      | 'log'
      | 'stage.start'
      | 'stage.end'
      | 'tool.start'
      | 'tool.end'
      | 'usage'
      | 'conversation.progress'
      | 'run.fact'
      | 'context.state'
      | 'stream.start'
      | 'stream.end'
    >
  | StreamChunkEvent;
