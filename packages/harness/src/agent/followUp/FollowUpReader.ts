/**
 * One run's reader, and the rules of a run's input: whether a message is
 * queued for it ({@link sendVerdict}), whether what is queued obliges a
 * resume ({@link needsWake}), and which queued messages a run reads at each
 * point of its loop. The rows are the authority; the reader holds no copy
 * of them and nothing here takes a row: a batch is consumed by the
 * `followup.consumed` rows its reader commits with the message it became.
 * A reader with nothing to read waits on the session log for the next
 * message queued for its run, or for the inbox to say the run takes no more.
 */
import { Effect, Latch, Option, Stream } from 'effect';

import { COMPACTION_REQUEST } from '@agent/runtime/run/compaction';
import type { RunId } from '@shared/schemas';
import { isMessage, type QueuedFollowUp } from '@shared/session/runRows';
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
): QueuedFollowUp[] {
  return rows.filter(
    (f) => isMessage(f) && (f.holdUntil === undefined || at !== 'request'),
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
      readonly followUps: readonly QueuedFollowUp[];
    }
  | { readonly kind: 'synthetic'; readonly text: string };

/** A `/compact` is pending: it wakes an idle run. */
const compacting = (rows: readonly QueuedFollowUp[]): boolean =>
  rows.some((f) => f.control?.kind === 'compact');

/** The messages in `rows` readable at `at`, when there are any. */
const batch = (
  rows: readonly QueuedFollowUp[],
  at: InputPoint,
): Extract<FollowUpBatch, { kind: 'followUps' }> | null => {
  const followUps = readableMessages(rows, at);
  return followUps.length > 0 ? { kind: 'followUps', followUps } : null;
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
  private readonly onClosed: (heard: () => void) => () => void;

  /** `onClosed` hears the run take no more input (it was deleted, its
   *  input closed, or its session closes) and returns the detach. */
  constructor(
    runId: RunId,
    log: ReaderLog,
    onClosed: (heard: () => void) => () => void,
  ) {
    this.runId = runId;
    this.log = log;
    this.onClosed = onClosed;
  }

  /** The run's input, read from its committed rows. */
  private readonly input: Effect.Effect<RunRowsRead<'input'>> = Effect.suspend(
    () => Effect.orDie(this.log.runRows(this.runId, 'input')),
  );

  /** The run's pending follow-ups. */
  private readonly queued: Effect.Effect<readonly QueuedFollowUp[]> =
    Effect.map(this.input, ({ followUps }) => followUps);

  /** The run's own pending requests (`/compact`, a model switch). */
  readonly controls: Effect.Effect<readonly QueuedFollowUp[]> = Effect.map(
    this.queued,
    (rows) => rows.filter((f) => f.control !== undefined),
  );

  /** The messages readable at `at`, when there are any; nothing is taken. */
  readonly read = (
    at: InputPoint,
  ): Effect.Effect<Extract<FollowUpBatch, { kind: 'followUps' }> | null> =>
    Effect.map(this.queued, (rows) => batch(rows, at));

  /** Whether `next` would return now: a message readable at `at`, or a
   *  `/compact`. */
  readonly hasPending = (at: InputPoint): Effect.Effect<boolean> =>
    Effect.map(
      this.queued,
      (rows) => compacting(rows) || batch(rows, at) !== null,
    );

  /** Block for the next batch readable at `at`; null once the run takes no
   *  more input or its session closed. */
  readonly next = (at: InputPoint): Effect.Effect<FollowUpBatch | null> =>
    Effect.suspend(() => {
      // Heard from before the first read, so no close falls between a read
      // and the wait after it.
      const closed = Latch.makeUnsafe(false);
      const detach = this.onClosed(() => Latch.openUnsafe(closed));
      return Effect.gen({ self: this }, function* () {
        for (;;) {
          // A row landing after this read is above `from`.
          const from = this.log.now();
          const { followUps: rows, inputClosed } = yield* this.input;
          // Closed before this call began to listen.
          if (inputClosed) return null;
          const readable = batch(rows, at);
          if (readable !== null) return readable;
          if (compacting(rows))
            return { kind: 'synthetic', text: COMPACTION_REQUEST } as const;
          const arrived = yield* Effect.raceFirst(
            this.log.tail(from).pipe(
              Stream.filter(
                (event) =>
                  event.type === 'followup.queued' &&
                  event.aggregateId === this.runId,
              ),
              Stream.runHead,
              Effect.map(Option.isSome),
              Effect.orDie,
            ),
            Effect.as(closed.await, false),
          );
          if (!arrived) return null;
        }
      }).pipe(Effect.ensuring(Effect.sync(detach)));
    });
}
