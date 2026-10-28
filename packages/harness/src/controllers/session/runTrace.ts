/**
 * Each run's trace sink (`RunTrace`): its rows in the publisher's order, the
 * transient text of what it streams, and what it left open. A row the store
 * refused is the run's own to hear at its end (`lost`), never another
 * writer's; the text a committed row closes is dropped as the tail delivers
 * it (`committed`). The trace's one read side is those rows and that text
 * read back (`replayTrace`).
 */
import { Effect, Stream, Struct, SubscriptionRef } from 'effect';

import type {
  ClosureFact,
  RunTrace,
  SessionLog,
  StreamClosure,
} from '@agent/runtime/SessionHandle';
import type { AgentEvent } from '@agent/trace';
import { runEventDraft } from '@agent/trace/TraceEmitter';
import { classifyAgentError } from '@common/errors/agentErrorClassification';
import { writeLogLine } from '@logger/logSink';
import {
  qualifyAggregateId,
  aggregateTarget,
  TOOL_CALL_STATUS,
  type RunId,
  type RunOutcome,
  type CommitOrdinal,
  type DisplaySessionEvent,
  type SessionEvent,
  type SessionViewInput,
  type TextChunk,
  type TranscriptSubscription,
  TRACE_ROW_TYPES,
} from '@shared/schemas';
import { lastLifecycleRow, runEndFromEvents } from '@shared/session/runFacts';
import { closesRunWindow } from '@shared/session/runRows';
import type { SessionEventsShape } from '@shared/session/sessionEvents';
import { ensureError } from '@utils/errors/errorMessage';

import type { InflightText, InflightTextChunk } from './sessionSources';

/** A session's trace sink, and the tail's hand-off of each committed row. */
export interface RunTraceSink extends RunTrace {
  /** The session log's display door ({@link SessionLog.publish}). */
  readonly publish: SessionLog['publish'];
  /** Drop the transient text a committed row closes: a stream's final text
   *  or a card's terminal result its own, a phase move that rests or ends
   *  the run, and its removal, every chunk of the run. */
  readonly committed: (row: SessionEvent) => Effect.Effect<void>;
}

/** What a trace sink is built over. */
export interface RunTraceInit {
  /** The root, named in what the sink logs. */
  readonly storage: string;
  readonly events: Pick<SessionEventsShape, 'detach' | 'openWork'>;
  /** The transient text the session's view folds beside its rows. */
  readonly text: SubscriptionRef.SubscriptionRef<InflightText>;
  /** The publisher's barrier: every row enqueued before it was tried. */
  readonly settled: Effect.Effect<void>;
  /** Whether the session's doors are shut. */
  readonly closed: () => boolean;
}

/** Build a session's {@link RunTraceSink}. */
export function makeRunTrace({
  storage,
  events,
  text,
  settled,
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
    let chunk = SubscriptionRef.getUnsafe(text).get(`${runId}/${id}`);
    if (chunk === undefined) return undefined;
    const pieces: string[] = [];
    while (chunk !== undefined) {
      pieces.push(chunk.text);
      chunk = chunk.previous;
    }
    return pieces.reverse().join('');
  };
  const appendText = (runId: RunId, id: string, chunk: string) =>
    SubscriptionRef.update(text, (held) => {
      const next = new Map(held);
      const key = `${runId}/${id}`;
      const previous = next.get(key);
      next.set(key, {
        previous,
        text: chunk,
        length: (previous?.length ?? 0) + chunk.length,
      });
      return next;
    });
  function closure(runId: RunId): StreamClosure[];
  function closure(runId: RunId, outcome: RunOutcome): ClosureFact[];
  function closure(runId: RunId, outcome?: RunOutcome): ClosureFact[] {
    const aggregateId = qualifyAggregateId('run', runId);
    return events
      .openWork(aggregateId)
      .flatMap(({ kind, id }): ClosureFact[] => {
        if (kind === 'stream')
          return [
            {
              type: 'stream.end',
              aggregateId,
              id,
              finalText: readText(runId, id),
            },
          ];
        return outcome === undefined
          ? []
          : [{ type: 'stage.end', aggregateId, id, status: outcome }];
      });
  }
  return {
    publish: (runId, event) => {
      if (refusedAfterClose()) return;
      if (event.type === 'stream.chunk') {
        const chunk = event.text;
        events.detach(() => appendText(runId, event.id, chunk), {
          order: true,
        });
        return;
      }
      // The call fixes the row's place in the order; the draft is built when
      // the publisher runs the job, after every chunk enqueued before it
      // reached the text, so a `stream.end` with no final text of its own
      // closes on the complete streamed text. The first refusal is kept.
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
          if (draft === null) return Effect.void;
          return append([draft]).pipe(
            Effect.tapError((refusal) =>
              Effect.sync(() => keep(runId, refusal)),
            ),
          );
          // Its transaction failing (a busy lock past the budget, the store
          // gate, the commit) loses the row as surely as a refusal does.
        },
        { failed: (error) => keep(runId, error) },
      );
    },
    lost: (runId) =>
      Effect.map(settled, () => {
        const refusal = lost.get(runId);
        lost.delete(runId);
        return refusal === undefined
          ? undefined
          : {
              kind: classifyAgentError(refusal),
              message: `Rows this run published were not written: ${refusal.message}`,
            };
      }),
    closure,
    committed: (row) => {
      const runId = aggregateTarget(row.aggregateId).id;
      let closes: ((key: string) => boolean) | null = null;
      if (row.type === 'stream.end')
        closes = (key) => key === `${runId}/${row.id}`;
      else if (
        row.type === 'tool.end' &&
        row.status !== TOOL_CALL_STATUS.IN_PROGRESS
      )
        closes = (key) => key === `${runId}/${row.logId}`;
      else if (row.type === 'run.removed' || closesRunWindow(row))
        closes = (key) => key.startsWith(`${runId}/`);
      const dropping = closes;
      if (dropping === null) return Effect.void;
      return SubscriptionRef.update(text, (held) => {
        let next: Map<string, InflightTextChunk> | null = null;
        for (const key of held.keys()) {
          if (!dropping(key)) continue;
          next ??= new Map(held);
          next.delete(key);
        }
        return next ?? held;
      });
    },
  };
}

/** The rows a trace event is stored as: every one but the chunk's. */
const STORED_TRACE: ReadonlySet<string> = new Set(TRACE_ROW_TYPES);
/** The columns the store adds to a trace event's row. */
const ENVELOPE = ['aggregateId', 'seq', 'commit', 'origin', 'at'] as const;

/** The `seq` the lifecycle `rows` end in starts after: its activation, or
 *  for a lifecycle that ended, the one before that end. */
function lifecycleStart(rows: readonly SessionEvent[], runId: RunId): number {
  const last = lastLifecycleRow(rows, runId);
  if (last === undefined) return -1;
  if (runEndFromEvents([last], runId) === null) return last.seq;
  const before = rows.filter((row) => row.seq < last.seq);
  return lastLifecycleRow(before, runId)?.seq ?? -1;
}

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
    /** `settled`: every write enqueued so far is committed; `now()`: the
     *  head. */
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
    /** Rows at or below this `seq` are read, or precede the activation. */
    let seq = -1;
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
    const eventsOf = (row: DisplaySessionEvent): AgentEvent[] => {
      if (row.seq <= seq) return [];
      seq = row.seq;
      // Its end, the next activation, or the run's removal ends the read.
      ended ||=
        row.type === 'run.removed' ||
        lastLifecycleRow([row], runId) !== undefined;
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
      seq = lifecycleStart(
        read
          .filter(own)
          .flatMap(({ event }) => (event.commit <= activation ? [event] : [])),
        runId,
      );
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
