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

  enqueue(value: string): void {
    if (this.resolver) {
      const resolver = this.resolver;
      this.resolver = null;
      resolver(value);
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
    if (this.resolver) {
      const resolver = this.resolver;
      this.resolver = null;
      resolver(null);
    }
  }

  clear(): void {
    this.queued.length = 0;
  }

  dispose(): void {
    this.cancelWait();
    this.clear();
  }
}
