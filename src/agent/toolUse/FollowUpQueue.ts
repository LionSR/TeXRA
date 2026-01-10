/**
 * Promise-based queue for follow-up messages in a tool-use session.
 *
 * This is a standalone data structure with no dependencies on other
 * toolUse modules, allowing it to be imported without circular dependency issues.
 */

/**
 * Promise-based queue for follow-up messages in a tool-use session.
 */
export class FollowUpQueue {
  private readonly queued: string[] = [];
  private resolver: ((value: string | null) => void) | null = null;

  /** Resolves pending wait with value and clears resolver */
  private resolveWait(value: string | null): void {
    const resolver = this.resolver;
    this.resolver = null;
    resolver?.(value);
  }

  enqueue(value: string): void {
    if (this.resolver) {
      this.resolveWait(value);
    } else {
      this.queued.push(value);
    }
  }

  isEmpty(): boolean {
    return this.queued.length === 0;
  }

  drain(): string[] {
    return this.queued.splice(0);
  }

  waitForNext(checkInterruption: () => boolean): Promise<string | null> {
    if (!this.isEmpty()) {
      return Promise.resolve(this.queued.shift()!);
    }
    if (checkInterruption()) {
      return Promise.resolve(null);
    }
    return new Promise<string | null>((resolve) => {
      this.resolver = resolve;
    });
  }

  cancelWait(): void {
    this.resolveWait(null);
  }

  clear(): void {
    this.queued.length = 0;
  }

  dispose(): void {
    this.cancelWait();
    this.clear();
  }

  /**
   * Get a copy of all queued messages for display purposes.
   * This doesn't modify the queue.
   */
  getAll(): string[] {
    return [...this.queued];
  }
}
