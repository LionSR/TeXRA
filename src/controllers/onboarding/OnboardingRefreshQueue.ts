import { Effect, Semaphore } from 'effect';

/** Serialize funnel refreshes and collapse an in-flight burst to one rerun. */
export class OnboardingRefreshQueue {
  /** One permit: a refresh holds it while it runs; callers that arrive
   *  meanwhile wait in order and find nothing left to do once the single
   *  rerun they asked for has landed. */
  private readonly lane = Semaphore.makeUnsafe(1);
  private rerunRequested = false;

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

  /** Ask for a refresh. The host edge runs the returned effect; a rejection
   *  is the refresh's own error. */
  run(): Effect.Effect<void, unknown> {
    return Effect.suspend(() => {
      this.rerunRequested = true;
      return this.lane.withPermit(this.drain());
    });
  }
}
