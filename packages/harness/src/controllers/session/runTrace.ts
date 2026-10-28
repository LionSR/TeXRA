/**
 * Each run's trace sink (`RunTrace`): its rows in the publisher's order, the
 * transient text of what it streams, and what it left open. A row the store
 * refused is the run's own to hear at its end (`lost`), never another
 * writer's; the text a committed row closes is dropped as the tail delivers
 * it (`committed`).
 */
import { Effect, Stream, SubscriptionRef } from 'effect';

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

/** Every trace event the session stores as a row: all but the transient
 *  chunk, whose text the session keeps only until its row commits. Its type
 *  fails to compile, naming the arm, while `TRACE_ROW_TYPES` misses one. */
const STORED_TRACE: ReadonlySet<string> &
  ([UnstoredArm] extends [never]
    ? unknown
    : { readonly missing: UnstoredArm }) = new Set(TRACE_ROW_TYPES);

/** Where a replay is in its run's inputs. */
interface Replay {
  readonly runId: RunId;
  /** Rows at or below this `seq` are read, or precede the run's latest
   *  activation. */
  seq: number;
  /** The text each open row has carried so far, by its stream or card id. */
  readonly text: Map<string, string>;
  /** Streams whose end is read: text still delivered for one after its end
   *  is already in its final text. */
  readonly closed: Set<string>;
  /** Whether the run's `run.end` or `run.removed` is read. */
  ended: boolean;
}

/** A live text input as the chunk it extends its row with, if it does. */
function chunkOf(replay: Replay, input: TextChunk): AgentEvent[] {
  if (input.runId !== replay.runId || replay.closed.has(input.rowId)) return [];
  const held = replay.text.get(input.rowId) ?? '';
  if (input.to <= held.length || input.from > held.length) return [];
  const text = input.text.slice(held.length - input.from);
  replay.text.set(input.rowId, held + text);
  return [{ type: 'stream.chunk', id: input.rowId, text }];
}

/** A row of the run as the trace events it stands for. */
function eventsOf(replay: Replay, row: DisplaySessionEvent): AgentEvent[] {
  if (row.seq <= replay.seq) return [];
  replay.seq = row.seq;
  if (
    row.type === 'run.removed' ||
    runEndFromEvents([row], replay.runId) !== null
  ) {
    replay.ended = true;
    return [];
  }
  if (!STORED_TRACE.has(row.type)) return [];
  const out: AgentEvent[] = [];
  if (row.type === 'stream.end') {
    // A stream that ends with text no chunk carried gets it as one chunk.
    const held = replay.text.get(row.id) ?? '';
    replay.text.delete(row.id);
    replay.closed.add(row.id);
    const missing = row.finalText?.startsWith(held)
      ? row.finalText.slice(held.length)
      : '';
    if (missing) out.push({ type: 'stream.chunk', id: row.id, text: missing });
  }
  const {
    aggregateId: _id,
    seq: _seq,
    commit: _c,
    origin: _o,
    at: _at,
    ...event
  } = row;
  // cast: a stored trace row is its trace event plus the envelope removed above (`runEventDraft` adds the aggregate, the store the rest).
  out.push(event as AgentEvent);
  return out;
}

/** The `seq` the run's current lifecycle starts after: its latest
 *  activation, or, for a lifecycle that already ended, the activation
 *  before that end. */
function lifecycleStart(rows: readonly SessionEvent[], runId: RunId): number {
  const last = lastLifecycleRow(rows, runId);
  if (last === undefined) return -1;
  if (runEndFromEvents([last], runId) === null) return last.seq;
  const before = rows.filter((row) => row.seq < last.seq);
  return lastLifecycleRow(before, runId)?.seq ?? -1;
}

/**
 * A run's trace read back from its session's view inputs:
 * the trace rows of its latest activation, then each as it commits, until
 * its `run.end`; then `result`'s failure, if it fails. For a reader that
 * comes after a run's buffered trace is gone, a second reader, or a window
 * whose run another process runs.
 *
 * A stream's text arrives as chunks as the session sees it. A stream that
 * ends with text no chunk carried, because it streamed before the reader
 * came, gets that text as one chunk before its `stream.end`, so a reader's
 * chunks always add up to each stream's final text.
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
): Stream.Stream<AgentEvent, E> {
  const id = qualifyAggregateId('run', runId);
  return Stream.suspend(() => {
    const replay: Replay = {
      runId,
      seq: -1,
      text: new Map(),
      closed: new Set(),
      ended: false,
    };
    let first = true;
    /** A row of this run from its history or the tail. The listing is
     *  every run's latest rows, a summary, not history. */
    const own = (
      input: SessionViewInput,
    ): input is Extract<SessionViewInput, { _tag: 'event' }> =>
      input._tag === 'event' &&
      input.read !== 'listing' &&
      input.event.aggregateId === id;
    const take = (batch: readonly SessionViewInput[]): AgentEvent[] => {
      // The first batch is the whole history: start at the run's latest
      // activation, as a reader of this activation's live trace does.
      if (first) {
        first = false;
        replay.seq = lifecycleStart(
          batch.flatMap((input) => (own(input) ? [input.event] : [])),
          runId,
        );
      }
      return batch.flatMap((input) => {
        if (replay.ended) return [];
        if (input._tag === 'chunk') return chunkOf(replay, input);
        return own(input) ? eventsOf(replay, input.event) : [];
      });
    };
    return read([{ id, fromSeq: 0 }], 0, false).pipe(
      Stream.map(take),
      // After the read, so the batch holding the run's end is the last.
      Stream.takeUntil(() => replay.ended),
      Stream.flattenIterable,
      Stream.concat(Stream.drain(Stream.fromEffect(result))),
    );
  });
}
