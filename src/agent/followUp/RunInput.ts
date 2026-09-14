/**
 * One run's follow-up input queue: an Effect `Queue` per owner generation,
 * seeded from the run's folded `followup.queued` rows that have no
 * `followup.consumed`, plus the follow-ups the session's admission boundary
 * queues for that owner while it runs.
 */
import { Queue, type Cause, Effect } from 'effect';

import type { SessionEvent } from '@shared/schemas';

/** One queued follow-up as its row carries it. */
export type QueuedFollowUp = Pick<
  Extract<SessionEvent, { type: 'followup.queued' }>,
  'followUpId' | 'content'
>;

/**
 * What a run takes from its queue: queued follow-ups in queue order, or the
 * loop's own maintenance wake (an immediate compaction's turn), which is no
 * row and never shares a batch with follow-ups.
 */
export type FollowUpBatch =
  | { readonly synthetic: false; readonly followUps: readonly QueuedFollowUp[] }
  | { readonly synthetic: true; readonly text: string };

type InputEntry =
  | { readonly kind: 'followUp'; readonly followUp: QueuedFollowUp }
  | { readonly kind: 'synthetic'; readonly text: string };

/**
 * One owner generation's input queue. The session's admission boundary
 * offers each follow-up it queues for the owner; the consumer that folds
 * the run seeds it once with the pending rows the fold holds. Follow-ups
 * offered before that seed are held behind it, which is their commit order:
 * a row the fold does not hold was committed after the claim that attached
 * this queue. Ids dedupe the overlap (a row both offered and folded).
 */
export class RunInput {
  private readonly seen = new Set<string>();
  private held: QueuedFollowUp[] | null = [];

  private constructor(
    private readonly queue: Queue.Queue<InputEntry, Cause.Done>,
  ) {}

  static readonly make: Effect.Effect<RunInput> = Effect.map(
    Queue.unbounded<InputEntry, Cause.Done>(),
    (queue) => new RunInput(queue),
  );

  offer(followUp: QueuedFollowUp): void {
    if (this.seen.has(followUp.followUpId)) return;
    this.seen.add(followUp.followUpId);
    if (this.held) this.held.push(followUp);
    else Queue.offerUnsafe(this.queue, { kind: 'followUp', followUp });
  }

  /**
   * Seed with the fold's pending follow-ups, then release what was held.
   * `known` is every id the fold holds, consumed ones included: a held or
   * later offer of a consumed id is a replayed delivery, and is dropped.
   */
  seed(
    pending: readonly QueuedFollowUp[],
    known: ReadonlySet<string> = new Set(),
  ): void {
    const unseen = pending.filter((f) => !this.seen.has(f.followUpId));
    const pendingIds = new Set(pending.map((f) => f.followUpId));
    const held = (this.held ?? []).filter(
      (f) => pendingIds.has(f.followUpId) || !known.has(f.followUpId),
    );
    for (const id of [...pendingIds, ...known]) this.seen.add(id);
    this.held = null;
    Queue.offerAllUnsafe(
      this.queue,
      [...unseen, ...held].map((followUp) => ({
        kind: 'followUp' as const,
        followUp,
      })),
    );
  }

  /** Wake the consumer for a maintenance turn. */
  wake(text: string): void {
    Queue.offerUnsafe(this.queue, { kind: 'synthetic', text });
  }

  hasQueued(): boolean {
    return (this.held?.length ?? 0) > 0 || Queue.sizeUnsafe(this.queue) > 0;
  }

  /** End the generation: what it still holds stays queued on the run's rows. */
  end(): void {
    while (Queue.sizeUnsafe(this.queue) > 0) Queue.takeUnsafe(this.queue);
    Queue.endUnsafe(this.queue);
  }

  /** Block for the next batch; null once the generation ended. */
  readonly take: Effect.Effect<FollowUpBatch | null> = Effect.suspend(() =>
    Effect.gen({ self: this }, function* () {
      const first = yield* Queue.take(this.queue);
      if (first.kind === 'synthetic') {
        return { synthetic: true, text: first.text } as const;
      }
      const followUps = [first.followUp];
      while (Queue.sizeUnsafe(this.queue) > 0) {
        const next = yield* Queue.peek(this.queue);
        if (next.kind !== 'followUp') break;
        yield* Queue.take(this.queue);
        followUps.push(next.followUp);
      }
      return { synthetic: false, followUps } as const;
    }).pipe(Effect.catchTag('Done', () => Effect.succeed(null))),
  );

  /** Take a queued batch without blocking; null when none is queued. */
  readonly poll: Effect.Effect<FollowUpBatch | null> = Effect.suspend(() =>
    Queue.sizeUnsafe(this.queue) > 0 ? this.take : Effect.succeed(null),
  );

  /** Block until input is queued, taking nothing; false once ended. */
  readonly ready: Effect.Effect<boolean> = Effect.suspend(() =>
    Queue.peek(this.queue).pipe(
      Effect.as(true),
      Effect.catchTag('Done', () => Effect.succeed(false)),
    ),
  );
}
