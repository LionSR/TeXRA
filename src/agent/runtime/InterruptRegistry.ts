/** Registry for live executions that can be interrupted by stream id. */

import type { ToolUseFlowContext } from '@agent/implementations/flows/tooluse';
import type { StreamTabId } from '@shared/schemas';

/** Live flow or process handle that can receive a user stop request. */
export interface IInterruptible {
  interrupt(): void;
}

function isToolUseFlowContext(
  entry: IInterruptible | undefined,
): entry is ToolUseFlowContext {
  const session = (entry as ToolUseFlowContext | undefined)?.session;
  return session !== undefined && typeof session.appendFollowUp === 'function';
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

  getToolUseFlowContext(
    streamTabId: StreamTabId,
  ): ToolUseFlowContext | undefined {
    const entry = this.entries.get(streamTabId);
    return isToolUseFlowContext(entry) ? entry : undefined;
  }

  retainOnly(streamIds: ReadonlySet<StreamTabId>): void {
    for (const streamId of this.entries.keys()) {
      if (!streamIds.has(streamId)) {
        this.entries.delete(streamId);
      }
    }
  }
}

export const interruptRegistry = new InterruptRegistry();
