/**
 * Promise-based queue for follow-up messages in a tool-use session.
 *
 * This is a standalone data structure with no dependencies on other
 * toolUse modules, allowing it to be imported without circular dependency issues.
 *
 * Entries expire after a TTL (default 5 minutes). Expired entries are
 * silently dropped during consumption and display.
 */

interface QueueEntry {
  value: string;
  enqueuedAt: number;
}

/** Default TTL: 5 minutes. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class FollowUpQueue {
  private readonly queued: QueueEntry[] = [];
  private resolver: ((value: string | null) => void) | null = null;
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** Resolves pending wait with value and clears resolver */
  private resolveWait(value: string | null): void {
    const resolver = this.resolver;
    this.resolver = null;
    resolver?.(value);
  }

  /** Drop expired entries from the front of the queue. */
  private pruneExpired(): void {
    const now = Date.now();
    while (
      this.queued.length > 0 &&
      now - this.queued[0].enqueuedAt > this.ttlMs
    ) {
      this.queued.shift();
    }
  }

  enqueue(value: string): void {
    if (this.resolver) {
      this.resolveWait(value);
    } else {
      this.queued.push({ value, enqueuedAt: Date.now() });
    }
  }

  isEmpty(): boolean {
    this.pruneExpired();
    return this.queued.length === 0;
  }

  drain(): string[] {
    this.pruneExpired();
    return this.queued.splice(0).map((e) => e.value);
  }

  waitForNext(checkInterruption: () => boolean): Promise<string | null> {
    this.pruneExpired();
    if (this.queued.length > 0) {
      return Promise.resolve(this.queued.shift()!.value);
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
   * Expired entries are excluded.
   */
  getAll(): string[] {
    this.pruneExpired();
    return this.queued.map((e) => e.value);
  }
}
