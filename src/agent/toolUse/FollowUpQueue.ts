/**
 * Promise-based queue for follow-up messages in a tool-use session.
 *
 * This is a standalone data structure with no dependencies on other
 * toolUse modules, allowing it to be imported without circular dependency issues.
 */

export class FollowUpQueue {
  private readonly queued: string[] = [];
  private resolver: ((value: string | null) => void) | null = null;

  enqueue(value: string): void {
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
    return this.queued.splice(0);
  }

  waitForNext(checkInterruption: () => boolean): Promise<string | null> {
    if (this.queued.length > 0) {
      return Promise.resolve(this.queued.shift()!);
    }
    if (checkInterruption()) {
      return Promise.resolve(null);
    }
    return new Promise<string | null>((resolve) => {
      this.resolver = resolve;
    });
  }

  /**
   * Wait for at least one item, then drain all available.
   * Returns null if interrupted.
   */
  async waitAndDrainAll(
    checkInterruption: () => boolean,
  ): Promise<string[] | null> {
    const first = await this.waitForNext(checkInterruption);
    if (first === null) return null;
    return [first, ...this.drain()];
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
    return [...this.queued];
  }
}
