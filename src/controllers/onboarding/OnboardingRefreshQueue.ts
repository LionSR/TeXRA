import { Effect, Semaphore } from 'effect';

/** Serialize funnel refreshes and collapse an in-flight burst to one rerun. */
export class OnboardingRefreshQueue {
  /** One permit: a refresh holds it while it runs; callers that arrive
   *  meanwhile wait in order and find nothing left to do once the single
   *  rerun they asked for has landed. */
  private readonly lane = Semaphore.makeUnsafe(1);
  private rerunRequested = false;

  /** The latch and the program it reruns are one pair: the refresh is
   *  captured here, with the latch that records a request for it, so one
   *  consumer's `run` can only ever be answered by its own refresh. */
  constructor(private readonly refresh: () => Promise<void>) {}

  private readonly drain = Effect.fn('OnboardingRefreshQueue.run')(function* (
    this: OnboardingRefreshQueue,
  ) {
    while (this.rerunRequested) {
      this.rerunRequested = false;
      yield* Effect.tryPromise({
        try: () => this.refresh(),
        catch: (error) => error,
      });
    }
  });

  /**
   * Ask for a refresh: the caller that finds the lane free runs it, callers
   * that arrive while it runs are collapsed into the single rerun it performs
   * afterwards, and every caller returns once the rerun it asked for has
   * landed. A refresh that fails keeps the host's own error identity.
   *
   * The request is latched when the program starts, not when it is built, so
   * an unrun `run` leaves no rerun owed to nobody.
   */
  run(): Effect.Effect<void, unknown> {
    return Effect.suspend(() => {
      this.rerunRequested = true;
      return this.lane.withPermit(this.drain());
    });
  }
}
