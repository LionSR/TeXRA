/**
 * Each run's trace sink (`RunTrace`): its rows in the publisher's order, the
 * transient text of what it streams, and what it left open. A row the store
 * refused is the run's own to hear at its end (`lost`), never another
 * writer's; the text a committed row closes is dropped as the tail delivers
 * it (`committed`).
 */
import { Effect, SubscriptionRef } from 'effect';

import type {
  ClosureFact,
  RunTrace,
  StreamClosure,
} from '@agent/runtime/SessionHandle';
import { runEventDraft } from '@agent/runtime/SessionEvents';
import { classifyAgentError } from '@common/errors';
import { writeLogLine } from '@logger/logSink';
import {
  aggregateId as qualifyAggregateId,
  aggregateTarget,
  TOOL_CALL_STATUS,
  type RunId,
  type RunOutcome,
  type SessionEvent,
} from '@shared/schemas';
import type {
  DatabaseNotOwner,
  DatabaseWriteFailed,
} from '@shared/session/database';
import { closesRunWindow } from '@shared/session/runRows';
import type { SessionEventsShape } from '@shared/session/sessionEvents';

import type { InflightText, InflightTextChunk } from './sessionSources';

/** A session's trace sink, and the tail's hand-off of each committed row. */
export interface RunTraceSink extends RunTrace {
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
  const lost = new Map<RunId, DatabaseNotOwner | DatabaseWriteFailed>();
  let reportedLateWrite = false;
  /** A row after the doors shut writes nothing, and the first says so: what
   *  still publishes then is a run that outlived its session's close. */
  const refusedAfterClose = (): boolean => {
    if (!closed()) return false;
    if (!reportedLateWrite) {
      reportedLateWrite = true;
      writeLogLine(
        'WARN',
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
        events.detach(() => appendText(runId, event.id, chunk));
        return;
      }
      // The call fixes the row's place in the order; the draft is built when
      // the publisher runs the job, after every chunk enqueued before it
      // reached the text, so a `stream.end` with no final text of its own
      // closes on the complete streamed text. The first refusal is kept.
      events.detach((append) => {
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
            Effect.sync(() => {
              if (!lost.has(runId)) lost.set(runId, refusal);
            }),
          ),
        );
      });
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
