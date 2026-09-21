/**
 * Resident transcript entries: a cache of the session's run rows, never a
 * second authority over them.
 *
 * One run's cache is seeded from the rows committed so far and advanced from
 * there by the session's ordered tail ({@link StreamLogStore.acceptCommitted}),
 * which is its only writer. Nothing serializes the seed against the tail
 * because nothing publishes a run's rows before its residency exists: a launch
 * retains the run before it attaches its trace (`AgentLaunchContext`,
 * `createChildRun`), and a host focuses a run before the resume that revives it
 * (`chatSessionController`). So the seed is a prefix of what the tail delivers,
 * and no permit or sequence comparison decides where the two meet.
 */
import { Effect, type Context } from 'effect';

import {
  aggregateId,
  aggregateTarget,
  isTranscriptEvent,
  type SessionEvent,
  type RunId,
  RUN_PHASE,
} from '@shared/schemas';
import type { Database } from '@shared/session/database';
import { StreamLog } from '@shared/session/traceEntries';
import { createTranscriptFold } from '@shared/session/traceFold';

type TranscriptDatabase = Pick<
  Context.Service.Shape<typeof Database>,
  'readAggregate'
>;
export type StreamLogStoreMode =
  | { readonly kind: 'persistent' }
  | { readonly kind: 'ephemeral'; readonly reason: string };

export interface TranscriptResidencyLease {
  readonly runId: RunId;
  close(): void;
}

/** One run's cached transcript: the fold of the rows this process has seen,
 *  how many leases retain it, and whether a host holds it in focus. */
interface CachedRun {
  log: StreamLog;
  fold: ReturnType<typeof createTranscriptFold>;
  /** The committed prefix has been folded in; the tail advances it from here. */
  hydrated: boolean;
  leases: number;
  focused: boolean;
}

/** Apply one event with the same projection used by the live recorder. */
function applyEvent(
  log: StreamLog,
  fold: ReturnType<typeof createTranscriptFold>,
  event: SessionEvent,
): void {
  if (event.type === 'run.activate') fold.status(RUN_PHASE.RUNNING);
  else if (event.type === 'flow.step') {
    if (event.payload.step === 'waiting') fold.status(RUN_PHASE.WAITING);
    else if (event.payload.step !== 'halted') fold.status(RUN_PHASE.RUNNING);
  } else if (event.type === 'child.park') {
    fold.status(
      event.phase === 'parked' ? RUN_PHASE.WAITING : RUN_PHASE.RUNNING,
    );
  } else if (event.type === 'run.end') fold.status(event.outcome);
  else if (isTranscriptEvent(event))
    fold.record(event, {
      at: event.at,
      id: JSON.stringify([event.aggregateId, event.seq]),
      debug: event.transcriptDebug ?? false,
    });
}

function foldEntries(events: readonly SessionEvent[]):
  | {
      readonly log: StreamLog;
      readonly fold: ReturnType<typeof createTranscriptFold>;
    }
  | undefined {
  if (events.length === 0 || events.at(-1)?.type === 'run.removed') return;
  if (events[0]?.type !== 'run.start' || events[0].seq !== 1) {
    throw new Error('A transcript read must begin with its creation row.');
  }
  const log = new StreamLog();
  const fold = createTranscriptFold(log);
  for (const event of events) applyEvent(log, fold, event);
  log.drainEmission();
  return { log, fold };
}

export class StreamLogStore {
  private readonly runs = new Map<RunId, CachedRun>();

  private constructor(
    readonly mode: StreamLogStoreMode,
    private readonly database: TranscriptDatabase,
  ) {}

  /** The root's resident transcript cache. It holds nothing until a run is
   *  retained or a host loads one. */
  static open(
    database: TranscriptDatabase,
    mode: StreamLogStoreMode = { kind: 'persistent' },
  ): StreamLogStore {
    return new StreamLogStore(mode, database);
  }

  /** The run's cached transcript, or undefined when nothing holds one. */
  get(runId: RunId): StreamLog | undefined {
    return this.runs.get(runId)?.log;
  }

  /** Read a complete event prefix without changing residency. */
  readEntries(runId: RunId) {
    return this.database
      .readAggregate(aggregateId('run', runId), 0)
      .pipe(Effect.map((events) => foldEntries(events)?.log.toJSON() ?? []));
  }

  /** The run aggregate's committed events; empty when the run never existed
   *  or is tombstoned. */
  readEvents(runId: RunId) {
    return this.database
      .readAggregate(aggregateId('run', runId), 0)
      .pipe(
        Effect.map((events) =>
          events.length === 0 || events.at(-1)?.type === 'run.removed'
            ? []
            : events,
        ),
      );
  }

  /** Drop a run's cache once nothing retains it. An ephemeral transcript has
   *  no durable rows to re-read, so it is never dropped. */
  requestEviction(runId: RunId): void {
    if (this.mode.kind === 'ephemeral') return;
    const cached = this.runs.get(runId);
    if (cached === undefined) return;
    cached.focused = false;
    if (cached.leases === 0) this.runs.delete(runId);
  }

  /** Retain a run's transcript for the run itself, seeded from the rows it has
   *  already committed. */
  acquireRunResidency(runId: RunId) {
    return Effect.gen({ self: this }, function* () {
      const lease = this.retain(runId);
      yield* this.hydrate(runId).pipe(
        Effect.onError(() => Effect.sync(() => lease.close())),
      );
      return lease;
    });
  }

  /** Hold a run's transcript for the host displaying it, until that host asks
   *  for its eviction. */
  ensureLoaded(runId: RunId): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      yield* this.hydrate(runId);
      const cached = this.runs.get(runId);
      if (cached !== undefined) cached.focused = true;
    });
  }

  /** Advance the cache with one committed row, in commit order. A run nothing
   *  holds is not cached, and a committed removal forgets the run. */
  acceptCommitted(event: SessionEvent): void {
    const target = aggregateTarget(event.aggregateId);
    if (target.kind !== 'run') return;
    if (event.type === 'run.removed') {
      this.runs.delete(target.id);
      return;
    }
    const cached = this.runs.get(target.id);
    if (cached === undefined) return;
    applyEvent(cached.log, cached.fold, event);
    // Nothing here reads the log's change buffers; drain them so they do not
    // grow with the resident log.
    cached.log.drainEmission();
  }

  /** Fold the run's committed rows into its cache, once per run. */
  private hydrate(runId: RunId) {
    return Effect.gen({ self: this }, function* () {
      if (this.runs.get(runId)?.hydrated === true) return;
      const seed = foldEntries(
        yield* this.database.readAggregate(aggregateId('run', runId), 0),
      );
      const cached = this.runs.get(runId);
      if (cached === undefined) {
        // A run nothing retains enters the cache only when it has rows: an
        // absent or removed run leaves nothing behind.
        if (seed !== undefined) {
          this.runs.set(runId, {
            ...seed,
            hydrated: true,
            leases: 0,
            focused: false,
          });
        }
        return;
      }
      if (seed !== undefined) {
        cached.log = seed.log;
        cached.fold = seed.fold;
      }
      cached.hydrated = true;
    });
  }

  private retain(runId: RunId): TranscriptResidencyLease {
    let cached = this.runs.get(runId);
    if (cached === undefined) {
      const log = new StreamLog();
      cached = {
        log,
        fold: createTranscriptFold(log),
        hydrated: false,
        leases: 0,
        focused: false,
      };
      this.runs.set(runId, cached);
    }
    const entry = cached;
    entry.leases += 1;
    let closed = false;
    return {
      runId,
      close: () => {
        if (closed) return;
        closed = true;
        entry.leases -= 1;
      },
    };
  }
}
