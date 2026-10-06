/**
 * One run's reader for one generation: a wake signal over the follow-ups
 * the run's rows still queue. The rows are the authority; this holds no
 * copy of them.
 */
import { Deferred, Effect, Latch } from 'effect';

import type { QueuedFollowUp } from '@shared/session/runRows';
import { isInstruction } from './followUpMessages';

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

/** The message a `/compact` on a parked run wakes it with: the compaction
 *  runs at that turn's model boundary, which consumes the request. */
const COMPACTION_REQUEST =
  'The user requested immediate context compaction. Do not start a new task; continue only far enough for the runtime to process any available context compaction, and do not claim that compaction has completed.';

/**
 * What a run takes from its input: queued follow-ups in commit order, a
 * maintenance turn (a `/compact` with nothing else queued, or the loop's
 * continuation), which never shares a batch with follow-ups, or a view
 * edit, taken before either.
 */
export type FollowUpBatch =
  | {
      readonly kind: 'followUps';
      readonly followUps: readonly QueuedFollowUp[];
    }
  | { readonly kind: 'synthetic'; readonly text: string }
  | { readonly kind: 'edit'; readonly edit: ViewEdit };

/**
 * One generation's reader. A take reads the run's readable rows (`pending`)
 * from the store, so a row an earlier process left
 * queued and one sent while this generation runs arrive the same way, in
 * commit order. The inbox signals the reader when a row lands for it.
 *
 * A taken batch stays pending until its `followup.consumed` commit (the
 * tool-use `consume`, the agent-CLI child's turn settle), and the reader
 * takes again only after that commit, so a batch in flight is never read
 * twice.
 */
export class RunInput {
  private readonly signal = Latch.makeUnsafe(false);
  private edit: ViewEdit | null = null;
  /** The follow-ups queued when the edit was: delivered before it. */
  private beforeEdit: ReadonlySet<string> = new Set();
  private ended = false;

  /** The run's queued follow-ups, read from its committed rows. */
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

  /** The messages a take may read, folded from the rows' holds: an
   *  `instruction`-held row only beside an instruction. */
  private readonly pending: Effect.Effect<readonly QueuedFollowUp[]> =
    Effect.suspend(() =>
      Effect.map(this.queued, (queued) => {
        const rows = queued.filter((f) => f.control === undefined);
        const asked = rows.some(
          (f) => f.holdUntil !== 'instruction' && isInstruction(f.content),
        );
        return asked ? rows : rows.filter((f) => f.holdUntil !== 'instruction');
      }),
    );

  /** Wake the consumer: a follow-up row landed for it. */
  notify(): void {
    Latch.openUnsafe(this.signal);
  }

  /**
   * Queue one view edit, taken after the follow-ups already queued and
   * before anything queued later. False while another is queued or once the
   * generation has ended.
   */
  editView(edit: ViewEdit): Effect.Effect<boolean> {
    return Effect.map(this.pending, (pending) => {
      if (this.ended || this.edit !== null) return false;
      this.edit = edit;
      this.beforeEdit = new Set(pending.map((f) => f.followUpId));
      Latch.openUnsafe(this.signal);
      return true;
    });
  }

  /** A `/compact` is pending: it wakes a parked run. */
  private readonly compacting: Effect.Effect<boolean> = Effect.suspend(() =>
    Effect.map(this.controls, (controls) =>
      controls.some((f) => f.control?.kind === 'compact'),
    ),
  );

  /** Whether a take would return now: a view edit, a `/compact`, or a
   *  readable message is queued. */
  readonly hasQueued: Effect.Effect<boolean> = Effect.suspend(() =>
    this.edit !== null
      ? Effect.succeed(true)
      : Effect.zipWith(
          this.compacting,
          this.pending,
          (compacting, pending) => compacting || pending.length > 0,
        ),
  );

  /** The queued messages, when they are all a take would read now: no view
   *  edit is queued. Nothing is taken; it only reads. */
  readonly takeQueued: Effect.Effect<Extract<
    FollowUpBatch,
    { kind: 'followUps' }
  > | null> = Effect.suspend(() =>
    Effect.map(this.pending, (followUps) =>
      this.edit === null && followUps.length > 0
        ? ({ kind: 'followUps', followUps } as const)
        : null,
    ),
  );

  /** End the generation: what is pending stays queued on the run's rows; a
   *  view edit nobody took fails. */
  end(): void {
    this.ended = true;
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
        const pending = yield* this.pending;
        const edit = this.edit;
        if (edit !== null) {
          const earlier = pending.filter((f) =>
            this.beforeEdit.has(f.followUpId),
          );
          if (earlier.length > 0)
            return { kind: 'followUps', followUps: earlier } as const;
          this.edit = null;
          return { kind: 'edit', edit } as const;
        }
        if (pending.length > 0) {
          return { kind: 'followUps', followUps: pending } as const;
        }
        if (yield* this.compacting)
          return { kind: 'synthetic', text: COMPACTION_REQUEST } as const;
        yield* this.signal.await;
      }
    }),
  );
}
