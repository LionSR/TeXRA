/**
 * Promise-based queue for follow-up messages in a tool-use session.
 *
 * This is a standalone data structure with no dependencies on other
 * toolUse modules, allowing it to be imported without circular dependency issues.
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

  /**
   * Wait for at least one message, then drain and combine all available.
   * Returns all queued messages joined with double newlines.
   */
  async waitAndDrainAll(
    checkInterruption: () => boolean,
  ): Promise<string | null> {
    const first = await this.waitForNext(checkInterruption);
    if (first === null) {
      return null;
    }
    // Drain any additional messages that arrived while waiting
    const rest = this.drain();
    if (rest.length === 0) {
      return first;
    }
    return [first, ...rest].join('\n\n');
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
