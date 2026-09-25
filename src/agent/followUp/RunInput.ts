/**
 * One run's follow-up input for one owner generation: a wake signal over the
 * follow-ups the run's rows still queue. The rows are the authority; this
 * holds no copy of them.
 */
import { Data, Effect, Latch } from 'effect';

import type { QueuedFollowUp } from '@shared/session/runRows';

/**
 * What a run takes from its input: queued follow-ups in commit order, or the
 * loop's own maintenance wake (an immediate compaction's turn), which is no
 * row and never shares a batch with follow-ups.
 */
export type FollowUpBatch =
  | { readonly synthetic: false; readonly followUps: readonly QueuedFollowUp[] }
  | { readonly synthetic: true; readonly text: string };

/** A live consumer claim refused: another consumer already holds the run's input. */
export class FollowUpContinuationOwned extends Data.TaggedError(
  'FollowUpContinuationOwned',
)<{ readonly message: string }> {}

/**
 * One owner generation's input. A take reads what is pending from `pending`
 * (the session publisher's pending follow-ups, less the ids the admission
 * boundary holds back for a finalizing child), so a row an earlier process
 * left queued and one admitted while this generation runs arrive the same
 * way, in commit order. The admission boundary signals the generation when
 * a row lands for it.
 *
 * One consumer per generation. A taken batch stays pending until its
 * `followup.consumed` commit (the tool-use `consume`, the agent-CLI child's
 * turn settle), and a consumer takes again only after that commit, so a
 * batch in flight is never read twice.
 */
export class RunInput {
  private readonly signal = Latch.makeUnsafe(false);
  private readonly synthetic: string[] = [];
  private ended = false;

  constructor(private readonly pending: () => readonly QueuedFollowUp[]) {}

  /** Wake the consumer: a follow-up row landed for it. */
  notify(): void {
    Latch.openUnsafe(this.signal);
  }

  /**
   * Queue one maintenance turn. It is queued only while nothing is pending,
   * so every follow-up a later take finds arrived after it, and it is taken
   * first.
   */
  wake(text: string): void {
    this.synthetic.push(text);
    Latch.openUnsafe(this.signal);
  }

  hasQueued(): boolean {
    return this.synthetic.length > 0 || this.pending().length > 0;
  }

  /** End the generation: what is pending stays queued on the run's rows. */
  end(): void {
    this.ended = true;
    this.synthetic.length = 0;
    Latch.openUnsafe(this.signal);
  }

  /** Block for the next batch; null once the generation ended. */
  readonly take: Effect.Effect<FollowUpBatch | null> = Effect.suspend(() =>
    Effect.gen({ self: this }, function* () {
      for (;;) {
        if (this.ended) return null;
        // Closed before the read: a signal landing after it reopens the wait.
        Latch.closeUnsafe(this.signal);
        const text = this.synthetic.shift();
        if (text !== undefined) return { synthetic: true, text } as const;
        const followUps = this.pending();
        if (followUps.length > 0) {
          return { synthetic: false, followUps } as const;
        }
        yield* this.signal.await;
      }
    }),
  );
}
