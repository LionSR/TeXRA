/**
 * One run's follow-up input for one owner generation: a wake signal over the
 * follow-ups the run's rows still queue. The rows are the authority; this
 * holds no copy of them.
 */
import { Data, Deferred, Effect, Latch } from 'effect';

import type { QueuedFollowUp } from '@shared/session/runRows';

/**
 * A host's edit of a parked run's view (durable harness, gap 3): a reset
 * (`handoff` null) or a handoff, the reset with the user's note as the
 * message the next turn answers. `done` settles when its rows commit, or
 * fails when they are refused or the run's input ends first.
 */
export interface ViewEdit {
  readonly handoff: string | null;
  readonly done: Deferred.Deferred<void, Error>;
}

/**
 * What a run takes from its input: queued follow-ups in commit order, the
 * loop's own maintenance wake (an immediate compaction's turn), which is no
 * row and never shares a batch with follow-ups, or a view edit, taken before
 * either.
 */
export type FollowUpBatch =
  | {
      readonly kind: 'followUps';
      readonly followUps: readonly QueuedFollowUp[];
    }
  | { readonly kind: 'synthetic'; readonly text: string }
  | { readonly kind: 'edit'; readonly edit: ViewEdit };

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
  private edit: ViewEdit | null = null;
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

  /**
   * Queue one view edit, taken before anything else is. False while another
   * is queued or once the generation has ended.
   */
  editView(edit: ViewEdit): boolean {
    if (this.ended || this.edit !== null) return false;
    this.edit = edit;
    Latch.openUnsafe(this.signal);
    return true;
  }

  hasQueued(): boolean {
    return (
      this.edit !== null ||
      this.synthetic.length > 0 ||
      this.pending().length > 0
    );
  }

  /** End the generation: what is pending stays queued on the run's rows; a
   *  view edit nobody took fails. */
  end(): void {
    this.ended = true;
    this.synthetic.length = 0;
    if (this.edit !== null) {
      Deferred.doneUnsafe(
        this.edit.done,
        Effect.fail(new Error('The task stopped before its view was edited.')),
      );
      this.edit = null;
    }
    Latch.openUnsafe(this.signal);
  }

  /** Block for the next batch; null once the generation ended. */
  readonly take: Effect.Effect<FollowUpBatch | null> = Effect.suspend(() =>
    Effect.gen({ self: this }, function* () {
      for (;;) {
        if (this.ended) return null;
        // Closed before the read: a signal landing after it reopens the wait.
        Latch.closeUnsafe(this.signal);
        const edit = this.edit;
        if (edit !== null) {
          this.edit = null;
          return { kind: 'edit', edit } as const;
        }
        const text = this.synthetic.shift();
        if (text !== undefined) return { kind: 'synthetic', text } as const;
        const followUps = this.pending();
        if (followUps.length > 0) {
          return { kind: 'followUps', followUps } as const;
        }
        yield* this.signal.await;
      }
    }),
  );
}
