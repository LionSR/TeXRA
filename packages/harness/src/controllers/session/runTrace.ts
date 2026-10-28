/**
 * Each run's trace sink (`RunTrace`): its rows in the publisher's order, the
 * transient text of what it streams, and what it left open. A row the store
 * refused is the run's own to hear at its end (`lost`), never another
 * writer's; the text a committed row closes is dropped as the tail delivers
 * it (`committed`).
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

/** Each run's trace port: every caller reading the run's events, the
 *  launcher's and a joiner's alike, hears what the run emits from then on. */
function tracePorts(): Pick<RunTrace, 'tap' | 'listen'> {
  const ports = new Map<RunId, Set<(event: AgentEvent) => void>>();
  return {
    tap: (runId, event) => {
      for (const listener of ports.get(runId) ?? []) listener(event);
    },
    listen: (runId, listener) => {
      const port = ports.get(runId) ?? new Set();
      ports.set(runId, port.add(listener));
      return () => {
        port.delete(listener);
        if (port.size === 0) ports.delete(runId);
      };
    },
  };
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
    ...tracePorts(),
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

/** An `AgentEvent` arm, other than the chunk, that `TRACE_ROW_TYPES` misses. */
type UnstoredArm = Exclude<
  AgentEvent['type'],
  'stream.chunk' | (typeof TRACE_ROW_TYPES)[number]
>;

/** Every trace event the session stores as a row (all but the chunk); its
 *  type fails to compile, naming the arm, while `TRACE_ROW_TYPES` misses one. */
const STORED_TRACE: ReadonlySet<string> &
  ([UnstoredArm] extends [never]
    ? unknown
    : { readonly missing: UnstoredArm }) = new Set(TRACE_ROW_TYPES);

/** Where a replay is in its run's inputs. */
interface Replay {
  readonly runId: RunId;
  /** History until `replay.complete` (it may span frames); null once read. */
  history: SessionViewInput[] | null;
  /** Rows at or below this `seq` are read or precede the activation. */
  seq: number;
  /** Each open row's text so far, by stream or card id; null once its
   *  stream ended, when later text is already in its final text. */
  readonly text: Map<string, string | null>;
  /** The commit read through (the last `drained`), and the store's head once
   *  the run was over (null before): past it, every row the run wrote. */
  drainedTo: number;
  endAt: number | null;
  /** Its `run.end`, a later `run.activate` or `run.removed` is read (a run
   *  that ended without one is done once read through `endAt`). */
  ended: boolean;
}

/** A live text input as the chunk it extends its row with, if it does. */
function chunkOf(replay: Replay, input: TextChunk): AgentEvent[] {
  const stored = replay.text.get(input.rowId);
  if (input.runId !== replay.runId || stored === null) return [];
  const held = stored ?? '';
  if (input.to <= held.length || input.from > held.length) return [];
  const text = input.text.slice(held.length - input.from);
  replay.text.set(input.rowId, held + text);
  return [{ type: 'stream.chunk', id: input.rowId, text }];
}

/** The columns the store adds to a trace event's row. */
const ENVELOPE = ['aggregateId', 'seq', 'commit', 'origin', 'at'] as const;

/** A row of the run as the trace events it stands for. */
function eventsOf(replay: Replay, row: DisplaySessionEvent): AgentEvent[] {
  if (row.seq <= replay.seq) return [];
  replay.seq = row.seq;
  if (
    row.type === 'run.removed' ||
    lastLifecycleRow([row], replay.runId) !== undefined
  ) {
    replay.ended = true;
    return [];
  }
  if (!STORED_TRACE.has(row.type)) return [];
  // cast: a stored trace row is its trace event plus the envelope the store and `runEventDraft` add.
  const event = Struct.omit(row, ENVELOPE) as AgentEvent;
  if (row.type !== 'stream.end') return [event];
  // A stream that ends with text no chunk carried gets it as one chunk.
  const held = replay.text.get(row.id) ?? '';
  replay.text.set(row.id, null);
  const missing = row.finalText?.startsWith(held)
    ? row.finalText.slice(held.length)
    : '';
  return missing
    ? [{ type: 'stream.chunk', id: row.id, text: missing }, event]
    : [event];
}

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
 * A run's trace read back from its session's view inputs, for a reader its
 * in-memory trace cannot serve: the rows of the reader's activation, then each
 * as it commits, until its `run.end` (or, with none stored, every row
 * committed when the run was over: `store`); then `result`'s failure. A
 * stream that ended before the reader came arrives as one chunk of its final
 * text, so a reader's chunks always add up to each stream's final text.
 */
export function replayTrace<E>(
  /** The session's ordered view inputs for one reader: a session handle's
   *  `view.inputs`, or a `Session.view.watch` with its arguments spread. */
  read: (
    set: readonly TranscriptSubscription[],
    fromCommit: CommitOrdinal,
    debug: boolean,
  ) => Stream.Stream<readonly SessionViewInput[]>,
  runId: RunId,
  result: Effect.Effect<unknown, E>,
  /** `settled`: every write enqueued so far is committed; `now()`: the head. */
  store: {
    readonly settled: Effect.Effect<void>;
    readonly now: () => CommitOrdinal;
  },
  /** A commit in the reader's activation: it reads the latest at or before. */
  activation: CommitOrdinal,
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
    const replay: Replay = {
      runId,
      history: [],
      seq: -1,
      text: new Map(),
      drainedTo: -1,
      endAt: null,
      ended: false,
    };
    const done = (): boolean =>
      replay.ended ||
      (replay.endAt !== null && replay.drainedTo >= replay.endAt);
    const readInput = (input: SessionViewInput): AgentEvent[] => {
      if (done()) return [];
      if (input._tag === 'chunk') return chunkOf(replay, input);
      if (input._tag === 'drained') replay.drainedTo = input.cursor;
      return own(input) ? eventsOf(replay, input.event) : [];
    };
    /** One batch of inputs, or the store's head once the run is over. */
    const take = (
      next: readonly SessionViewInput[] | CommitOrdinal,
    ): AgentEvent[] => {
      if (typeof next === 'number') {
        replay.endAt = next;
        return [];
      }
      if (replay.history === null) return next.flatMap(readInput);
      replay.history.push(...next);
      if (!next.some((input) => input._tag === 'replay.complete')) return [];
      // The whole history: start at the reader's activation, as a reader
      // of its live trace does.
      const history = replay.history;
      replay.history = null;
      const rows = history.flatMap((input) =>
        own(input) && input.event.commit <= activation ? [input.event] : [],
      );
      replay.seq = lifecycleStart(rows, runId);
      return history.flatMap(readInput);
    };
    const over = Effect.exit(result).pipe(
      Effect.andThen(store.settled),
      Effect.andThen(Effect.sync(store.now)),
    );
    return read([{ id, fromSeq: 0 }], 0, false).pipe(
      Stream.merge(Stream.fromEffect(over)),
      // `done` as of each batch: a whole chunk maps before any is tested.
      Stream.map((next) => ({ events: take(next), last: done() })),
      Stream.takeUntil((read) => read.last),
      Stream.flatMap((read) => Stream.fromIterable(read.events)),
      Stream.concat(Stream.drain(Stream.fromEffect(result))),
    );
  });
}
