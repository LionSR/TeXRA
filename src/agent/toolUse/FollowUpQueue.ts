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
  private readonly listeners = new Set<() => void>();

  enqueue(value: string): void {
    if (this.resolver) {
      const resolver = this.resolver;
      this.resolver = null;
      resolver(value);
    } else {
      this.queued.push(value);
    }
    this.notifyListeners();
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
    this.listeners.clear();
  }

  onEnqueue(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async runIfIdle<T>(
    work: () => Promise<T>,
  ): Promise<{ aborted: boolean; result?: T }> {
    if (!this.isEmpty()) {
      return { aborted: true };
    }

    let aborted = false;
    const unsubscribe = this.onEnqueue(() => {
      aborted = true;
    });

    try {
      const result = await work();
      if (aborted || !this.isEmpty()) {
        return { aborted: true, result };
      }
      return { aborted: false, result };
    } finally {
      unsubscribe();
    }
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
