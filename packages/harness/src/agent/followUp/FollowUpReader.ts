/**
 * One run's reader, and the rules of a run's input: whether a message is
 * queued for it ({@link sendVerdict}), whether what is queued obliges a
 * resume ({@link needsWake}), and which queued messages a run reads at each
 * point of its loop. The rows are the authority; the reader holds no copy
 * of them and nothing here takes a row: a batch is consumed by the
 * `followup.consumed` rows its reader commits with the message it became.
 * A reader hands a step of the loop one reading of the input
 * ({@link InputReading}); with nothing to read it waits on the session log for
 * the next message queued for its run, for the time a note the run wrote to
 * itself is due, or for the inbox to end it.
 */
import { Clock, Effect, Latch, Option, Stream } from 'effect';

import { COMPACTION_REQUEST } from '@agent/runtime/run/compaction';
import type { CommitOrdinal, RunId } from '@shared/schemas';
import {
  controlOf,
  isMessage,
  type QueuedFollowUp,
  type QueuedMessage,
} from '@shared/session/runRows';
import type { RunRowsRead } from '@shared/session/runRowReads';
import type { SessionLogShape } from '@shared/session/sessionLog';

/** Where in its loop a run reads its input: before a model request inside
 *  a turn, at the turn's end, or while it waits for input. */
type InputPoint = 'request' | 'turn' | 'idle';

/** When a run's own note for a later time (`from.kind: 'self'`) becomes
 *  readable; undefined for every other row, which holds no time. */
const dueOf = ({ content: { from } }: QueuedFollowUp): number | undefined =>
  from.kind === 'self' ? from.due : undefined;

/**
 * The pending messages a run reads at `at` when the clock says `now`, in
 * commit order. A row held until the turn ends is not read before a request
 * inside the turn, and a run's own note for a later time is not read before
 * it is due.
 */
function readableMessages(
  rows: readonly QueuedFollowUp[],
  at: InputPoint,
  now: number,
): QueuedMessage[] {
  return rows.filter((f): f is QueuedMessage => {
    const due = dueOf(f);
    return (
      isMessage(f) &&
      (due === undefined || due <= now) &&
      (f.holdUntil === undefined || at !== 'request')
    );
  });
}

/**
 * Whether a message from `from`, committed at `commit`, obliges a resume of
 * a run no fiber drives. While the run's current lifecycle has not ended
 * (it waits on a child, or its fiber left without an end), any run's
 * message wakes it, as the user's does, and so it does once the run ended,
 * except after a user's Stop (that lifecycle's `run.stop` says `user`):
 * then only the user's message committed after that stop wakes it, so no
 * run undoes a person's stop. A resumed run that crashed carries no end, so
 * no earlier Stop of it holds a message back. A host's notification wakes
 * nothing: it is read by a run already running. A run's own note wakes it
 * as a run's message does, once it is readable.
 */
const wakes = (
  { end, stop }: RunRowsRead<'input'>,
  from: QueuedFollowUp['content']['from'],
  commit: number,
): boolean => {
  if (from.kind === 'notification') return false;
  const stopped = end !== null && stop?.reason === 'user';
  return !stopped || (from.kind === 'user' && commit > stop.commit);
};

/**
 * Whether a run's pending input obliges a resume of it when no fiber here
 * drives it, from its input rows (`followup.queued`, `followup.consumed`,
 * `run.activate`, `run.end`), over the messages readable at idle when the
 * clock says `now` ({@link wakes}). A closed input obliges none.
 */
export function needsWake(input: RunRowsRead<'input'>, now: number): boolean {
  return (
    !input.inputClosed &&
    readableMessages(input.followUps, 'idle', now).some(({ commit, content }) =>
      wakes(input, content.from, commit),
    )
  );
}

/**
 * What a run's input rows say of one send: the row is queued; it repeats a
 * row already sent under its id (`queued`: still unread); or it is refused,
 * writing nothing. `closed`: the run was deleted or its input closed.
 * `stopped`: a run's message to a run its user stopped, which would wait
 * unread until the user continues that run; a child's report is not such a
 * message and stays queued for that resume.
 */
export type SendVerdict =
  | { readonly kind: 'queue' }
  | { readonly kind: 'replay'; readonly queued: boolean }
  | { readonly kind: 'refused'; readonly reason: 'closed' | 'stopped' };

/** The verdict on sending `row` to the run whose input rows are `input`:
 *  the one rule every send, a plugin's and a child's report included, is
 *  decided by, in the job that commits it. */
export function sendVerdict(
  input: RunRowsRead<'input'>,
  row: Pick<QueuedFollowUp, 'followUpId' | 'content'>,
): SendVerdict {
  if (input.inputClosed) return { kind: 'refused', reason: 'closed' };
  const queued = input.followUps.some((f) => f.followUpId === row.followUpId);
  if (queued || input.taken.has(row.followUpId))
    return { kind: 'replay', queued };
  const { from } = row.content;
  if (
    from.kind === 'run' &&
    !('delivery' in row.content) &&
    !wakes(input, from, Infinity)
  )
    return { kind: 'refused', reason: 'stopped' };
  return { kind: 'queue' };
}

/**
 * What a run reads from its input: the messages readable at this point, or
 * a text the loop itself supplies (a `/compact` with nothing else queued, a
 * Stop hook's block), which never shares a batch with messages.
 */
export type FollowUpBatch =
  | {
      readonly kind: 'followUps';
      readonly followUps: readonly QueuedMessage[];
    }
  | { readonly kind: 'synthetic'; readonly text: string };

/**
 * A run's input as one read of its rows found it: what a step of the loop
 * decides from, so a step reads the input once.
 */
interface InputReading {
  /** The run's own pending requests (`/compact`, a model switch). */
  readonly controls: readonly QueuedFollowUp[];
  /** The messages readable at `at`, when there are any; nothing is taken. */
  readonly batch: (
    at: InputPoint,
  ) => Extract<FollowUpBatch, { kind: 'followUps' }> | null;
  /** Whether a wait at `at` would return at once: a message readable
   *  there, or a `/compact`. */
  readonly pending: (at: InputPoint) => boolean;
  /** Where the log stood before the read: a later row is above it. */
  readonly from: CommitOrdinal;
  /** When the run's earliest note not yet due becomes readable, in epoch
   *  milliseconds; undefined when none waits for its time. A time, not a
   *  delay: a wait that starts after the read sleeps until it, never for
   *  the delay the read saw. */
  readonly nextDue: number | undefined;
}

const inputOf = (
  rows: readonly QueuedFollowUp[],
  from: CommitOrdinal,
  now: number,
): InputReading => {
  const batch: InputReading['batch'] = (at) => {
    const followUps = readableMessages(rows, at, now);
    return followUps.length > 0 ? { kind: 'followUps', followUps } : null;
  };
  const compacting = rows.some((f) => controlOf(f)?.kind === 'compact');
  const later = rows.flatMap((f) => {
    const due = dueOf(f);
    return due !== undefined && due > now ? [due] : [];
  });
  return {
    controls: rows.filter((f) => !isMessage(f)),
    batch,
    pending: (at) => compacting || batch(at) !== null,
    from,
    nextDue: later.length > 0 ? Math.min(...later) : undefined,
  };
};

/** Sleep until the clock reads `due`, in epoch milliseconds. */
const sleepUntil = (due: number): Effect.Effect<void> =>
  Effect.flatMap(Clock.currentTimeMillis, (now) =>
    now >= due ? Effect.void : Effect.sleep(due - now),
  );

/** What a reader reads of the session's log. */
type ReaderLog = Pick<SessionLogShape, 'runRows' | 'tail' | 'now'>;

/**
 * One run's reader over its pending rows: a row an earlier process left
 * queued and one sent while this run runs arrive the same way, in commit
 * order.
 */
export class FollowUpReader {
  private readonly runId: RunId;
  private readonly log: ReaderLog;
  private readonly closed = Latch.makeUnsafe(false);

  constructor(runId: RunId, log: ReaderLog) {
    this.runId = runId;
    this.log = log;
  }

  /** The run takes no more input (it was deleted, its input closed, or its
   *  session closes): a wait ends, now or when it starts. */
  end(): void {
    Latch.openUnsafe(this.closed);
  }

  /** The run's input now, in one read of its committed rows. */
  readonly read: Effect.Effect<InputReading> = Effect.suspend(() => {
    const from = this.log.now();
    return Effect.all([
      this.log.runRows(this.runId, 'input'),
      Clock.currentTimeMillis,
    ]).pipe(
      Effect.map(([{ followUps }, now]) => inputOf(followUps, from, now)),
      Effect.orDie,
    );
  });

  /** Block for the next batch readable at `at`, starting from what `seen`
   *  found; null once the run takes no more input ({@link end}). */
  readonly next = (
    at: InputPoint,
    seen: InputReading,
  ): Effect.Effect<FollowUpBatch | null> =>
    Effect.gen({ self: this }, function* () {
      for (let input = seen; ; input = yield* this.read) {
        if (Latch.isOpen(this.closed)) return null;
        const readable = input.batch(at);
        if (readable !== null) return readable;
        if (input.pending(at))
          return { kind: 'synthetic', text: COMPACTION_REQUEST } as const;
        const arrived = yield* Effect.raceAllFirst([
          this.log.tail(input.from).pipe(
            Stream.filter(
              (event) =>
                event.type === 'followup.queued' &&
                event.aggregateId === this.runId,
            ),
            Stream.runHead,
            Effect.map(Option.isSome),
            Effect.orDie,
          ),
          Effect.as(this.closed.await, false),
          // A note the run wrote to itself becomes readable with no row
          // committed: the wait ends when its time comes, measured from
          // the clock as the wait starts (the step opened since the read
          // takes time, and the clock may have moved past the due time).
          ...(input.nextDue === undefined
            ? []
            : [Effect.as(sleepUntil(input.nextDue), true)]),
        ]);
        if (!arrived) return null;
      }
    });
}
