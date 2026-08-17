import PQueue from 'p-queue';

/** Serialize funnel refreshes and collapse an in-flight burst to one rerun. */
export class OnboardingRefreshQueue {
  private readonly queue = new PQueue({ concurrency: 1 });
  private rerunRequested = false;

  constructor(private readonly refresh: () => Promise<void>) {}

  run(): Promise<void> {
    this.rerunRequested = true;
    return this.queue.add(async () => {
      while (this.rerunRequested) {
        this.rerunRequested = false;
        await this.refresh();
      }
    });
  }
}
