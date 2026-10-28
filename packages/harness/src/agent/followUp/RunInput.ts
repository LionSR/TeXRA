/**
 * One run's reader for one generation: a wake signal over the follow-ups
 * the run's rows still queue. The rows are the authority; this holds no
 * copy of them, and nothing here takes a row: a batch is consumed by the
 * `followup.consumed` rows its reader commits with the message it became.
 */
import { Effect, Latch } from 'effect';

import { COMPACTION_REQUEST } from '@agent/runtime/run/compaction';
import {
  type InputPoint,
  readableMessages,
  staleNotices,
} from '@shared/session/runFacts';
import type { QueuedFollowUp, RunLookup } from '@shared/session/runRows';

/**
 * What a run reads from its input: the messages readable at this point, with
 * the stale notices consumed beside them, or a text the loop itself supplies
 * (a `/compact` with nothing else queued, a Stop hook's block), which never
 * shares a batch with messages.
 */
export type FollowUpBatch =
  | {
      readonly kind: 'followUps';
      readonly followUps: readonly QueuedFollowUp[];
      /** Notices of children that ended: consumed, never delivered. */
      readonly stale: readonly QueuedFollowUp[];
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
  private readonly run: RunLookup;

  constructor(
    queued: Effect.Effect<readonly QueuedFollowUp[]>,
    run: RunLookup,
  ) {
    this.queued = queued;
    this.run = run;
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

  /** The messages in `rows` readable at `at`, with the stale notices. */
  private batch(
    rows: readonly QueuedFollowUp[],
    at: InputPoint,
  ): Extract<FollowUpBatch, { kind: 'followUps' }> | null {
    const followUps = readableMessages(rows, at, this.run);
    const stale = staleNotices(rows, this.run);
    return followUps.length > 0 || stale.length > 0
      ? { kind: 'followUps', followUps, stale }
      : null;
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
