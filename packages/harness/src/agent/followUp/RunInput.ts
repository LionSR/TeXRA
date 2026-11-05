/**
 * One run's reader for one generation: a wake signal over the follow-ups
 * the run's rows still queue, and the rules for which of them it reads at
 * each point of its loop (and which wake it when it rests). The rows are the
 * authority; this holds no copy of them, and nothing here takes a row: a
 * batch is consumed by the `followup.consumed` rows its reader commits with
 * the message it became.
 */
import { Effect, Latch } from 'effect';

import { COMPACTION_REQUEST } from '@agent/runtime/run/compaction';
import { isInstruction } from '@shared/session/runFacts';
import { isMessage, type QueuedFollowUp } from '@shared/session/runRows';
import type { RunRows } from '@shared/session/runRowsShape';

/** Where in its loop a run reads its input: before a model request inside
 *  a turn, at the turn's end, or while it waits for input. */
export type InputPoint = 'request' | 'turn' | 'idle';

/**
 * The pending messages a run reads at `at`, in commit order. A row held
 * until an instruction (a child's pause or stop notice) is read only beside
 * one. A row held until the turn ends is not read before a request inside
 * the turn.
 */
function readableMessages(
  rows: readonly QueuedFollowUp[],
  at: InputPoint,
): QueuedFollowUp[] {
  const messages = rows.filter(isMessage);
  const asked = messages.some(
    (f) => f.holdUntil === undefined && isInstruction(f.content),
  );
  return messages.filter((f) => {
    switch (f.holdUntil) {
      case 'instruction':
        return asked;
      case 'turn':
        return at !== 'request';
      case undefined:
        return true;
    }
  });
}

/**
 * Whether a run's pending input obliges a resume of it when no generation
 * holds it, from its input rows (`followup.queued`, `followup.consumed`,
 * `run.activate`, `run.end`), over the messages readable at idle. While the
 * run's current lifecycle has not ended (it waits on a child, or its
 * generation left without an end), any run's message wakes it, as the
 * user's does. Once it ended, only the user's message or a child's delivery
 * does, and after a user's Stop (that lifecycle's `run.end` says `user`)
 * only the user's message committed after that end: a run's message never
 * revives a run that ended, and a host's notification wakes nothing: it is
 * read by a generation already running.
 */
export function needsWake(input: RunRows): boolean {
  // A resumed run that crashed carries no end, so no earlier Stop of it
  // holds a message back.
  const end = input.end;
  const stopped = end?.reason === 'user';
  return readableMessages(input.followUps, 'idle').some(
    ({ commit, content: { from } }) => {
      if (from.kind === 'notification') return false;
      if (from.kind === 'user') return !stopped || commit > end.commit;
      if (from.kind === 'run' && from.relation === 'child') return !stopped;
      return end === null;
    },
  );
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

/**
 * One generation's reader over the run's pending rows: a row an earlier
 * process left queued and one sent while this generation runs arrive the
 * same way, in commit order. The inbox signals the reader when a row lands
 * for it.
 */
export class RunInput {
  private readonly signal = Latch.makeUnsafe(false);
  private ended = false;

  /** The run's pending follow-ups, read from its committed rows. */
  private readonly queued: Effect.Effect<readonly QueuedFollowUp[]>;

  constructor(queued: Effect.Effect<readonly QueuedFollowUp[]>) {
    this.queued = queued;
  }

  /** The run's own pending requests (`/compact`, a model switch). */
  readonly controls: Effect.Effect<readonly QueuedFollowUp[]> = Effect.suspend(
    () =>
      Effect.map(this.queued, (rows) =>
        rows.filter((f) => f.control !== undefined),
      ),
  );

  /** Wake the reader: a follow-up row landed for it. */
  notify(): void {
    Latch.openUnsafe(this.signal);
  }

  /** The messages in `rows` readable at `at`, when there are any. */
  private batch(
    rows: readonly QueuedFollowUp[],
    at: InputPoint,
  ): Extract<FollowUpBatch, { kind: 'followUps' }> | null {
    const followUps = readableMessages(rows, at);
    return followUps.length > 0 ? { kind: 'followUps', followUps } : null;
  }

  /** The messages readable at `at`, when there are any; nothing is taken. */
  readonly read = (
    at: InputPoint,
  ): Effect.Effect<Extract<FollowUpBatch, { kind: 'followUps' }> | null> =>
    Effect.map(this.queued, (rows) => this.batch(rows, at));

  /** Whether `next` would return now: a message readable at `at`, or a
   *  `/compact`. */
  readonly hasPending = (at: InputPoint): Effect.Effect<boolean> =>
    Effect.map(
      this.queued,
      (rows) => compacting(rows) || this.batch(rows, at) !== null,
    );

  /** End the generation: what is pending stays queued on the run's rows. */
  end(): void {
    this.ended = true;
    Latch.openUnsafe(this.signal);
  }

  /** Block for the next batch readable at `at`; null once the generation
   *  ended. */
  readonly next = (at: InputPoint): Effect.Effect<FollowUpBatch | null> =>
    Effect.gen({ self: this }, function* () {
      for (;;) {
        if (this.ended) return null;
        // Closed before the read: a signal landing after it reopens the wait.
        Latch.closeUnsafe(this.signal);
        const rows = yield* this.queued;
        const batch = this.batch(rows, at);
        if (batch !== null) return batch;
        if (compacting(rows))
          return { kind: 'synthetic', text: COMPACTION_REQUEST } as const;
        yield* this.signal.await;
      }
    });
}
