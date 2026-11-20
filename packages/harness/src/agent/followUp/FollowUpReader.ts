/**
 * One run's reader, and the rules of a run's input: whether a message is
 * queued for it ({@link sendVerdict}), whether what is queued obliges a
 * resume ({@link needsWake}), and which queued messages a run reads at each
 * point of its loop. The rows are the authority; the reader holds no copy
 * of them and nothing here takes a row: a batch is consumed by the
 * `followup.consumed` rows its reader commits with the message it became.
 * A reader hands a step of the loop one reading of the input
 * ({@link InputReading}); with nothing to read it waits on the session log for
 * the next message queued for its run, or for the inbox to end it.
 */
import { Effect, Latch, Option, Stream } from 'effect';

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

/**
 * The pending messages a run reads at `at`, in commit order. A row held
 * until the turn ends is not read before a request inside the turn.
 */
function readableMessages(
  rows: readonly QueuedFollowUp[],
  at: InputPoint,
): QueuedMessage[] {
  return rows.filter(
    (f): f is QueuedMessage =>
      isMessage(f) && (f.holdUntil === undefined || at !== 'request'),
  );
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
 * nothing: it is read by a run already running.
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
 * `run.activate`, `run.end`), over the messages readable at idle
 * ({@link wakes}). A closed input obliges none.
 */
export function needsWake(input: RunRowsRead<'input'>): boolean {
  return (
    !input.inputClosed &&
    readableMessages(input.followUps, 'idle').some(({ commit, content }) =>
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
}

const inputOf = (
  rows: readonly QueuedFollowUp[],
  from: CommitOrdinal,
): InputReading => {
  const batch: InputReading['batch'] = (at) => {
    const followUps = readableMessages(rows, at);
    return followUps.length > 0 ? { kind: 'followUps', followUps } : null;
  };
  const compacting = rows.some((f) => controlOf(f)?.kind === 'compact');
  return {
    controls: rows.filter((f) => !isMessage(f)),
    batch,
    pending: (at) => compacting || batch(at) !== null,
    from,
  };
};

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
    return this.log.runRows(this.runId, 'input').pipe(
      Effect.map(({ followUps }) => inputOf(followUps, from)),
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
        const arrived = yield* Effect.raceFirst(
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
        );
        if (!arrived) return null;
      }
    });
}
