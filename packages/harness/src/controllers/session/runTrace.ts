/**
 * Each run's trace sink (the session log's `publish`, `lost` and `closure`): its rows in the publisher's order, the
 * transient text of what it streams, and what it left open. A row the store
 * refused is the run's own to hear at its end (`lost`), never another
 * writer's; the text a committed row closes is dropped as the publisher
 * publishes it (`committed`). The trace's one read side is those rows and that text
 * read back (`replayTrace`).
 */
import { Effect, Scheduler, Stream, Struct, SubscriptionRef } from 'effect';

import { runEventDraft } from '@agent/trace/TraceEmitter';
import { classifyAgentError } from '@common/errors/agentErrorClassification';
import { writeLogLine } from '@logger/logSink';
import type { AgentEvent } from '@shared/session/agentEvent';
import {
  qualifyAggregateId,
  aggregateTarget,
  TOOL_CALL_STATUS,
  type RunId,
  type CommitOrdinal,
  type DisplayRow,
  type SessionRow,
  type SessionViewInput,
  type TextChunk,
  type TranscriptSubscription,
  TRACE_ROW_TYPES,
} from '@shared/schemas';
import { boundsLifecycle } from '@shared/session/runFacts';
import { closesRunWindow } from '@shared/session/runRowReads';
import type { SessionEventsShape } from '@shared/session/sessionEvents';
import type {
  SessionLogShape,
  StreamClosure,
} from '@shared/session/sessionLog';
import { ensureError } from '@utils/errors/errorMessage';

import { textSince, type InflightText } from './sessionSources';

/** A session's trace sink, and the hand-off of each published row. */
interface RunTraceSink extends Pick<
  SessionLogShape,
  'publish' | 'lost' | 'closure'
> {
  /** Drop the transient text a committed row closes: a stream's final text
   *  or a card's terminal result its own, a phase move that rests or ends
   *  the run, and its removal, every chunk of the run. */
  readonly committed: (row: SessionRow) => Effect.Effect<void>;
}

/** What a trace sink is built over. */
interface RunTraceInit {
  /** The root, named in what the sink logs. */
  readonly storage: string;
  readonly events: Pick<SessionEventsShape, 'detach' | 'openWork'>;
  /** The transient text the session's view folds beside its rows. */
  readonly text: SubscriptionRef.SubscriptionRef<InflightText>;
  /** Run one update of the transient text now, from synchronous code. */
  readonly run: (update: Effect.Effect<void>) => unknown;
  /** Whether the session's doors are shut. */
  readonly closed: () => boolean;
}

/** Build a session's {@link RunTraceSink}. */
export function makeRunTrace({
  storage,
  events,
  text,
  run,
  closed,
}: RunTraceInit): RunTraceSink {
  /** Each run's first refused row, until its end takes it. */
  const lost = new Map<RunId, Error>();
  const keep = (runId: RunId, refusal: unknown) => {
    if (!lost.has(runId)) lost.set(runId, ensureError(refusal));
  };
  let reportedLateWrite = false;
  /** A row after the doors shut writes nothing, and the first says so: what
   *  still publishes then is a run that outlived its session's close. */
  const refusedAfterClose = (): boolean => {
    if (!closed()) return false;
    if (!reportedLateWrite) {
      reportedLateWrite = true;
      writeLogLine(
        'runTrace',
        `Session ${storage} is closed; a run still running published into it and nothing was written`,
      );
    }
    return true;
  };
  const readText = (runId: RunId, id: string): string | undefined => {
    const chunk = SubscriptionRef.getUnsafe(text).get(runId)?.get(id);
    return chunk === undefined ? undefined : textSince(chunk).text;
  };
  /** One update of the transient text as one uninterrupted turn: the ref's
   *  permit is never held while another update asks for it, so an update
   *  run from the synchronous door has landed when the call returns. */
  const updateText = (update: (held: InflightText) => InflightText) =>
    Effect.provideService(
      SubscriptionRef.update(text, update),
      Scheduler.PreventSchedulerYield,
      true,
    );
  const appendText = (runId: RunId, id: string, chunk: string) =>
    updateText((held) => {
      const rows = new Map(held.get(runId));
      const previous = rows.get(id);
      rows.set(id, {
        previous,
        text: chunk,
        length: (previous?.length ?? 0) + chunk.length,
      });
      return new Map(held).set(runId, rows);
    });
  const closure = (runId: RunId): StreamClosure[] => {
    const aggregateId = qualifyAggregateId('run', runId);
    return events.openWork(aggregateId).map((id) => ({
      type: 'stream.end',
      aggregateId,
      id,
      finalText: readText(runId, id),
    }));
  };
  return {
    publish: (runId, event) => {
      if (refusedAfterClose()) return;
      if (event.type === 'stream.chunk') {
        run(appendText(runId, event.id, event.text));
        return;
      }
      // Every chunk published before this call has reached the text, so a
      // `stream.end` with no final text of its own closes on the complete
      // streamed text. The first refusal is kept.
      events.detach(
        (append) => {
          const draft = runEventDraft(
            runId,
            event.type === 'stream.end'
              ? {
                  ...event,
                  finalText: event.finalText ?? readText(runId, event.id),
                }
              : event,
          );
          return draft === null ? Effect.void : append([draft]);
        },
        // A refused row, or its transaction failing (a busy lock past the
        // budget, the store gate, the commit), loses the row; the first loss
        // is kept for the run's end.
        { failed: (error) => keep(runId, error) },
      );
    },
    lost: (runId) =>
      Effect.sync(() => {
        const refusal = lost.get(runId);
        lost.delete(runId);
        return refusal === undefined
          ? undefined
          : {
              ...classifyAgentError(refusal),
              message: `Rows this run published were not written: ${refusal.message}`,
            };
      }),
    closure,
    committed: (row) => {
      const target = aggregateTarget(row.aggregateId);
      if (target.kind !== 'run') return Effect.void;
      // The row whose text is done with (null: every row of the run), or
      // nothing to drop.
      let closes: { readonly row: string | null } | undefined;
      if (row.type === 'stream.end') closes = { row: row.id };
      else if (
        row.type === 'tool.end' &&
        row.status !== TOOL_CALL_STATUS.IN_PROGRESS
      )
        closes = { row: row.logId };
      else if (row.type === 'run.removed' || closesRunWindow(row))
        closes = { row: null };
      const dropping = closes;
      if (dropping === undefined) return Effect.void;
      return updateText((held) => {
        const rows = held.get(target.id);
        const { row: dropped } = dropping;
        if (rows === undefined || (dropped !== null && !rows.has(dropped)))
          return held;
        const next = new Map(held);
        if (dropped === null || rows.size === 1) next.delete(target.id);
        else {
          const remaining = new Map(rows);
          remaining.delete(dropped);
          next.set(target.id, remaining);
        }
        return next;
      });
    },
  };
}

/** The rows a trace event is stored as: every one but the chunk's. */
const STORED_TRACE: ReadonlySet<string> = new Set(TRACE_ROW_TYPES);
/** The columns the store adds to a trace event's row. */
const ENVELOPE = ['aggregateId', 'seq', 'commit', 'at'] as const;

/**
 * A run's trace read back from its session's view inputs, for every reader
 * of `Run.events`: the rows of the reader's activation, then each as it
 * commits with the text streamed between them, until its `run.end` (or,
 * with none stored, every row committed when the run was over);
 * then `result`'s failure. A stream that ended before the reader came
 * arrives as one chunk of its final text, so a reader's chunks always add
 * up to each stream's final text.
 */
export function replayTrace<E>(
  session: {
    /** Ordered view inputs for one reader: a session handle's, or a
     *  `Session.view.watch` with its arguments spread. */
    readonly view: {
      readonly inputs: (
        set: readonly TranscriptSubscription[],
        fromCommit: CommitOrdinal,
        debug: boolean,
      ) => Stream.Stream<readonly SessionViewInput[]>;
    };
    /** `settled`: the view applied every write committed so far; `now()`:
     *  the head. */
    readonly log: {
      readonly settled: Effect.Effect<void>;
      readonly now: () => CommitOrdinal;
    };
  },
  runId: RunId,
  /** A commit in the reader's activation: it reads the latest at or before. */
  activation: CommitOrdinal,
  result: Effect.Effect<unknown, E>,
): Stream.Stream<AgentEvent, E> {
  const id = qualifyAggregateId('run', runId);
  /** A row of this run; the listing is a summary of every run, not history. */
  const own = (
    input: SessionViewInput,
  ): input is Extract<SessionViewInput, { _tag: 'event' }> =>
    input._tag === 'event' &&
    input.read !== 'listing' &&
    input.event.aggregateId === id;
  return Stream.suspend(() => {
    /** The inputs until `replay.complete`, which a watch can split over
     *  frames; null once read. */
    let history: SessionViewInput[] | null = [];
    /** Rows below this `seq` are read, or precede the activation; at it, the
     *  rows of the kinds in `kinds` are. One `seq` can hold two rows: a
     *  priced row and the `usage` row the store projects from it. */
    let seq = -1;
    const kinds = new Set<DisplayRow['type']>();
    /** Each open stream's or card's text so far; null once it ended, when
     *  its final text or result holds the rest. */
    const text = new Map<string, string | null>();
    /** The commit read through, and the store's head once the run was
     *  over: past it, every row the run wrote, its end stored or not. */
    let drainedTo = -1;
    let endAt: CommitOrdinal | null = null;
    let ended = false;
    const done = (): boolean => ended || (endAt !== null && drainedTo >= endAt);
    /** A live text input as the chunk it extends its stream with, if any. */
    const chunkOf = (input: TextChunk): AgentEvent[] => {
      const held = text.get(input.rowId);
      if (input.runId !== runId || held === null) return [];
      const at = held?.length ?? 0;
      if (input.to <= at || input.from > at) return [];
      const chunk = input.text.slice(at - input.from);
      text.set(input.rowId, (held ?? '') + chunk);
      return [{ type: 'stream.chunk', id: input.rowId, text: chunk }];
    };
    /** A row of the run as the trace events it stands for. */
    const eventsOf = (row: DisplayRow): AgentEvent[] => {
      if (row.seq < seq || (row.seq === seq && kinds.has(row.type))) return [];
      if (row.seq > seq) kinds.clear();
      seq = row.seq;
      kinds.add(row.type);
      // Its end, the next activation, or the run's removal ends the read.
      ended ||= row.type === 'run.removed' || boundsLifecycle(row, runId);
      if (!STORED_TRACE.has(row.type)) return [];
      // cast: a stored trace row is its trace event plus the envelope the store and `runEventDraft` add.
      const event = Struct.omit(row, ENVELOPE) as AgentEvent;
      // A closed card's output text is done with, as the session drops it.
      if (
        row.type === 'tool.end' &&
        row.status !== TOOL_CALL_STATUS.IN_PROGRESS
      )
        text.set(row.logId, null);
      if (row.type !== 'stream.end') return [event];
      // A stream that ends with text no chunk carried gets it as one chunk.
      const held = text.get(row.id) ?? '';
      text.set(row.id, null);
      const missing = row.finalText?.startsWith(held)
        ? row.finalText.slice(held.length)
        : '';
      return missing
        ? [{ type: 'stream.chunk', id: row.id, text: missing }, event]
        : [event];
    };
    const readInput = (input: SessionViewInput): AgentEvent[] => {
      if (done()) return [];
      if (input._tag === 'chunk') return chunkOf(input);
      if (input._tag === 'drained') drainedTo = input.cursor;
      return own(input) ? eventsOf(input.event) : [];
    };
    /** One batch of inputs, or the store's head once the run is over. */
    const take = (
      next: readonly SessionViewInput[] | CommitOrdinal,
    ): AgentEvent[] => {
      if (typeof next === 'number') {
        endAt = next;
        return [];
      }
      if (history === null) return next.flatMap(readInput);
      for (const input of next) history.push(input);
      if (!next.some((input) => input._tag === 'replay.complete')) return [];
      // The whole history: read from the reader's activation on.
      const read = history;
      history = null;
      // The lifecycle the reader's activation is in starts at its
      // `run.activate`, whether or not it has ended since. That row is read:
      // the reader starts after it.
      const start = read.findLast(
        (input): input is Extract<SessionViewInput, { _tag: 'event' }> =>
          own(input) &&
          input.event.commit <= activation &&
          input.event.type === 'run.activate',
      )?.event;
      if (start !== undefined) {
        seq = start.seq;
        kinds.add(start.type);
      }
      return read.flatMap(readInput);
    };
    const over = Effect.exit(result).pipe(
      Effect.andThen(session.log.settled),
      Effect.andThen(Effect.sync(session.log.now)),
    );
    return session.view.inputs([{ id, fromSeq: 0 }], 0, false).pipe(
      Stream.merge(Stream.fromEffect(over)),
      // `done` as of each batch: a whole chunk maps before any is tested.
      Stream.map((next) => ({ events: take(next), last: done() })),
      Stream.takeUntil((read) => read.last),
      Stream.flatMap((read) => Stream.fromIterable(read.events)),
      Stream.concat(Stream.drain(Stream.fromEffect(result))),
    );
  });
}
