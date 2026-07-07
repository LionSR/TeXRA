/** Registry for live executions that can be interrupted by stream id. */

import type { StreamTabId } from '@shared/schemas';

/** Live flow or process handle that can receive a user stop request. */
export interface IInterruptible {
  interrupt(): void;
}

export class InterruptRegistry {
  private readonly entries = new Map<StreamTabId, IInterruptible>();

  register(streamTabId: StreamTabId, interruptible: IInterruptible): void {
    this.entries.set(streamTabId, interruptible);
  }

  unregister(streamTabId: StreamTabId): void {
    this.entries.delete(streamTabId);
  }

  get(streamTabId: StreamTabId): IInterruptible | undefined {
    return this.entries.get(streamTabId);
  }

  retainOnly(streamIds: ReadonlySet<StreamTabId>): void {
    for (const streamId of this.entries.keys()) {
      if (!streamIds.has(streamId)) {
        this.entries.delete(streamId);
      }
    }
  }
}

export const SharedInterruptRegistry = new InterruptRegistry();
