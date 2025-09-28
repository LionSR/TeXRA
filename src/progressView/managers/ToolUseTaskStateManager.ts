// Local imports - agent types
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { ToolUseTaskState } from '@logger/TaskState';

/**
 * Maintains task state for tool-use sessions separately from workflow runs.
 */
export class ToolUseTaskStateManager {
  private readonly states = new Map<StreamTabId, ToolUseTaskState>();

  set(streamTabId: StreamTabId, state: ToolUseTaskState): void {
    this.states.set(streamTabId, { ...state });
  }

  get(streamTabId: StreamTabId): ToolUseTaskState | undefined {
    return this.states.get(streamTabId);
  }

  has(streamTabId: StreamTabId): boolean {
    return this.states.has(streamTabId);
  }

  delete(streamTabId: StreamTabId): void {
    this.states.delete(streamTabId);
  }

  clear(): void {
    this.states.clear();
  }

  size(): number {
    return this.states.size;
  }

  entries(): IterableIterator<[StreamTabId, ToolUseTaskState]> {
    return this.states.entries();
  }

  keys(): IterableIterator<StreamTabId> {
    return this.states.keys();
  }

  values(): IterableIterator<ToolUseTaskState> {
    return this.states.values();
  }

  setAll(states: Map<StreamTabId, ToolUseTaskState>): void {
    this.states.clear();
    for (const [stream, state] of states.entries()) {
      this.states.set(stream, { ...state });
    }
  }

  toObject(): Record<string, ToolUseTaskState> {
    return Object.fromEntries(this.states.entries());
  }
}
