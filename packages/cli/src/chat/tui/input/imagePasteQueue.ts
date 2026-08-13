export interface ImagePasteAttempt {
  readonly isCurrent: () => boolean;
}

export class ImagePasteQueue {
  private readonly pending = new Set<Promise<void>>();
  private deferredAction: (() => void) | null = null;
  private generation = 0;

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  get hasDeferredAction(): boolean {
    return this.deferredAction !== null;
  }

  beginAttempt(): ImagePasteAttempt {
    const generation = this.generation;
    return { isCurrent: () => generation === this.generation };
  }

  track(work: Promise<void>): void {
    this.pending.add(work);
    void work
      .finally(() => {
        this.pending.delete(work);
        this.flush();
      })
      .catch(() => undefined);
  }

  runWhenIdle(action: () => void): void {
    if (!this.deferUntilIdle(action)) action();
  }

  /** First submit wins while an image paste is pending. */
  deferUntilIdle(action: () => void): boolean {
    if (!this.hasPending) return false;
    this.deferredAction ??= action;
    return true;
  }

  cancelDeferredAction(): void {
    this.deferredAction = null;
  }

  /** Detach all work that belongs to a discarded draft. */
  discardPending(): void {
    this.generation += 1;
    this.pending.clear();
    this.deferredAction = null;
  }

  private flush(): void {
    if (this.hasPending) return;
    const action = this.deferredAction;
    this.deferredAction = null;
    action?.();
  }
}
