// Local imports - agent types
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { AgentCategory } from '@agent/core/AgentDataclass';

// Local imports - logger
import {
  type TaskState,
  isToolUseTaskState,
  isWorkflowTaskState,
} from '@logger/TaskState';

type TaskStateRecord = Record<StreamTabId, TaskState>;

/**
 * Stores task state keyed by stream identifier.
 *
 * All state is cloned on write so consumers can mutate the returned objects
 * without affecting the canonical store.
 */
export class TaskStateManager {
  private readonly states = new Map<StreamTabId, TaskState>();

  set(stream: StreamTabId, state: TaskState): void {
    this.states.set(stream, structuredClone(state));
  }

  get(stream: StreamTabId): TaskState | undefined {
    const value = this.states.get(stream);
    return value ? structuredClone(value) : undefined;
  }

  delete(stream: StreamTabId): void {
    this.states.delete(stream);
  }

  clear(): void {
    this.states.clear();
  }

  has(stream: StreamTabId): boolean {
    return this.states.has(stream);
  }

  keys(): StreamTabId[] {
    return Array.from(this.states.keys());
  }

  entries(): IterableIterator<[StreamTabId, TaskState]> {
    return this.states.entries();
  }

  size(): number {
    return this.states.size;
  }

  cloneAll(): Map<StreamTabId, TaskState> {
    return new Map(
      Array.from(this.states.entries(), ([stream, state]) => [
        stream,
        structuredClone(state),
      ]),
    );
  }

  setAll(record: TaskStateRecord): void {
    this.states.clear();
    for (const [stream, state] of Object.entries(record)) {
      this.set(stream as StreamTabId, state);
    }
  }

  toObject(): TaskStateRecord {
    return Object.fromEntries(
      Array.from(this.states.entries(), ([stream, state]) => [
        stream,
        structuredClone(state),
      ]),
    );
  }

  getActiveToolUseStreams(): Set<StreamTabId> {
    const active = new Set<StreamTabId>();
    for (const [stream, state] of this.states) {
      if (isToolUseTaskState(state)) {
        active.add(stream);
      }
    }
    return active;
  }

  filterByCategory(category: AgentCategory): StreamTabId[] {
    const matches: StreamTabId[] = [];
    for (const [stream, state] of this.states) {
      if (
        (category === AgentCategory.Workflow && isWorkflowTaskState(state)) ||
        (category === AgentCategory.ToolUse && isToolUseTaskState(state))
      ) {
        matches.push(stream);
      }
    }
    return matches;
  }
}
