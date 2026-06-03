export const IMAGE_PASTE_TIMEOUT_MS = 15_000;

export function withImagePasteTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error('Image paste timed out.')),
      IMAGE_PASTE_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

export class ImagePasteQueue {
  private readonly pending = new Set<Promise<void>>();
  private deferredAction: (() => void) | null = null;

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  get hasDeferredAction(): boolean {
    return this.deferredAction !== null;
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

  private flush(): void {
    if (this.hasPending) return;
    const action = this.deferredAction;
    this.deferredAction = null;
    action?.();
  }
}
