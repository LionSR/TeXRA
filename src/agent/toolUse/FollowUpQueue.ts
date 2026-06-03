/**
 * Promise-based queue for follow-up messages in a tool-use session.
 *
 * This is a standalone data structure with no dependencies on other
 * toolUse modules, allowing it to be imported without circular dependency issues.
 */

interface FollowUpQueueItem {
  readonly text: string;
  readonly synthetic: boolean;
  /** Media file paths (e.g. pasted images) attached to this user follow-up. */
  readonly mediaFiles?: readonly string[];
}

export interface FollowUpQueueBatch {
  readonly items: string[];
  readonly synthetic: boolean;
  /** Media file paths from the user follow-ups in this batch, flattened. */
  readonly mediaFiles: string[];
}

export class FollowUpQueue {
  private readonly queued: FollowUpQueueItem[] = [];
  private resolver: ((value: FollowUpQueueItem | null) => void) | null = null;

  enqueue(value: string, mediaFiles?: readonly string[]): void {
    this.enqueueItem({ text: value, synthetic: false, mediaFiles });
  }

  enqueueSynthetic(value: string): void {
    this.enqueueItem({ text: value, synthetic: true });
  }

  private enqueueItem(value: FollowUpQueueItem): void {
    if (this.resolver) {
      const resolve = this.resolver;
      this.resolver = null;
      resolve(value);
    } else {
      this.queued.push(value);
    }
  }

  isEmpty(): boolean {
    return this.queued.length === 0;
  }

  drain(): string[] {
    return this.queued
      .splice(0)
      .filter((item) => !item.synthetic)
      .map((item) => item.text);
  }

  /**
   * Drain queued visible follow-ups together with their media file paths.
   * Used by resume to replay queued user input without losing pasted images;
   * the text-only {@link drain} stays for display/back-compat.
   */
  drainItems(): Array<{ text: string; mediaFiles?: readonly string[] }> {
    return this.queued
      .splice(0)
      .filter((item) => !item.synthetic)
      .map((item) => ({ text: item.text, mediaFiles: item.mediaFiles }));
  }

  waitForNext(
    checkInterruption: () => boolean,
  ): Promise<FollowUpQueueItem | null> {
    if (this.queued.length > 0) {
      return Promise.resolve(this.queued.shift()!);
    }
    if (checkInterruption()) {
      return Promise.resolve(null);
    }
    return new Promise<FollowUpQueueItem | null>((resolve) => {
      this.resolver = resolve;
    });
  }

  /**
   * Wait for at least one item, then drain one batch.
   * Synthetic items are returned as a single-item batch; visible batches stop
   * at the next synthetic boundary so hidden maintenance turns do not merge
   * with user text.
   * Returns null if interrupted.
   */
  async waitAndDrainAll(
    checkInterruption: () => boolean,
  ): Promise<FollowUpQueueBatch | null> {
    const first = await this.waitForNext(checkInterruption);
    if (first === null) return null;
    if (first.synthetic) {
      return { items: [first.text], synthetic: true, mediaFiles: [] };
    }

    const items = [first.text];
    const mediaFiles: string[] = [...(first.mediaFiles ?? [])];
    while (true) {
      const next = this.queued[0];
      if (!next || next.synthetic) break;
      const item = this.queued.shift()!;
      items.push(item.text);
      if (item.mediaFiles?.length) mediaFiles.push(...item.mediaFiles);
    }
    return { items, synthetic: false, mediaFiles };
  }

  cancelWait(): void {
    const resolve = this.resolver;
    this.resolver = null;
    resolve?.(null);
  }

  dispose(): void {
    this.cancelWait();
    this.queued.length = 0;
  }

  /** Get a copy of all queued items for display purposes. */
  getAll(): string[] {
    return this.queued
      .filter((item) => !item.synthetic)
      .map((item) => item.text);
  }
}
