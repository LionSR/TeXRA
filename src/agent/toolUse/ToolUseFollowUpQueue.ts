// Local imports - logging
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { AgentLogger } from '@logger/AgentLogger';

const CHANNEL = 'ToolUseFollowUpQueue';
const logger = new AgentLogger(CHANNEL);

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

  size(): number {
    return this.queued.length;
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
    for (const listener of Array.from(this.listeners)) {
      listener();
    }
  }
}

/**
 * Static manager for follow-up queues indexed by stream ID.
 */
export class ToolUseFollowUpQueue {
  private static readonly queues = new Map<StreamTabId, FollowUpQueue>();
  private static readonly resuming = new Set<StreamTabId>();

  static acquire(streamId: StreamTabId): FollowUpQueue {
    let queue = this.queues.get(streamId);
    if (!queue) {
      queue = new FollowUpQueue();
      this.queues.set(streamId, queue);
    }
    return queue;
  }

  static release(streamId: StreamTabId): void {
    const queue = this.queues.get(streamId);
    if (!queue) {
      return;
    }
    queue.dispose();
    this.queues.delete(streamId);
    this.resuming.delete(streamId);
    logger.debug(`Released follow-up queue for stream ${streamId}.`);
  }

  static markResuming(streamId: StreamTabId): FollowUpQueue {
    const queue = this.acquire(streamId);
    if (!this.resuming.has(streamId)) {
      this.resuming.add(streamId);
      logger.debug(`Marked stream ${streamId} as resuming.`);
    }
    return queue;
  }

  static clearResuming(streamId: StreamTabId): void {
    if (!this.resuming.delete(streamId)) {
      return;
    }
    logger.debug(`Cleared resuming session tracking for stream ${streamId}.`);
  }

  static isResuming(streamId: StreamTabId): boolean {
    return this.resuming.has(streamId);
  }

  static enqueue(streamId: StreamTabId, followUp: string): boolean {
    const queue = this.queues.get(streamId);
    if (!queue) {
      return false;
    }
    queue.enqueue(followUp);
    logger.debug(`Queued follow-up for stream ${streamId}.`);
    return true;
  }

  static drain(streamId: StreamTabId): string[] {
    const queue = this.queues.get(streamId);
    if (!queue) {
      return [];
    }
    const drained = queue.drain();
    logger.debug(
      `Drained ${drained.length} queued follow-ups for stream ${streamId}.`,
    );
    return drained;
  }

  static get(streamId: StreamTabId): FollowUpQueue | undefined {
    return this.queues.get(streamId);
  }
}
