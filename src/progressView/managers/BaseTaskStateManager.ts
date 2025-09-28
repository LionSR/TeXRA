// Local imports - agent types
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { TaskState } from '@logger/TaskState';

/**
 * Shared map-backed storage for task state keyed by stream identifier.
 *
 * Subclasses provide cloning logic appropriate for their task-state variant so
 * callers receive isolated copies while shared collection helpers remain DRY.
 */
export abstract class BaseTaskStateManager<TState extends TaskState> {
  protected readonly states = new Map<StreamTabId, TState>();

  protected abstract cloneState(state: TState): TState;

  set(streamTabId: StreamTabId, state: TState): void {
    this.states.set(streamTabId, this.cloneState(state));
  }

  get(streamTabId: StreamTabId): TState | undefined {
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

  entries(): IterableIterator<[StreamTabId, TState]> {
    return this.states.entries();
  }

  keys(): IterableIterator<StreamTabId> {
    return this.states.keys();
  }

  values(): IterableIterator<TState> {
    return this.states.values();
  }

  setAll(states: Map<StreamTabId, TState>): void {
    this.states.clear();
    for (const [stream, state] of states.entries()) {
      this.set(stream, state);
    }
  }

  toObject(): Record<string, TState> {
    return Object.fromEntries(this.states.entries());
  }
}
