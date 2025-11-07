// Local imports - shared state and logging
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import {
  WorkspaceStateKey,
  type StateManager,
} from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';
import { LogMessageData } from '@logger/LogTypes';

/**
 * Manages stream tabs collection with persistence.
 * Handles adding, retrieving, and managing log messages for different streams.
 */
export class StreamTabsManager {
  private static readonly MAX_MESSAGE_HISTORY = 1000;
  private readonly logger: AgentLogger;
  private readonly items = new Map<StreamTabId, LogMessageData[]>();
  private readonly store: StateManager;

  constructor(store: StateManager) {
    this.store = store;
    this.logger = new AgentLogger('StreamTabsManager');
  }

  /**
   * Add a log message to a stream
   */
  addMessage(stream: StreamTabId, message: LogMessageData): void {
    const messages = this.ensureMessages(stream);
    messages.push(message);

    // Limit message history to prevent memory issues
    if (messages.length > StreamTabsManager.MAX_MESSAGE_HISTORY) {
      messages.splice(
        0,
        messages.length - StreamTabsManager.MAX_MESSAGE_HISTORY,
      );
    }

    this.persist();
  }

  /**
   * Create an empty stream if it doesn't exist
   */
  ensureStream(stream: StreamTabId): void {
    if (!this.has(stream)) {
      this.ensureMessages(stream);
      this.persist();
    }
  }

  /**
   * Delete a stream and its messages
   */
  delete(stream: StreamTabId): void {
    if (this.items.delete(stream)) {
      this.persist();
    }
  }

  /**
   * Clear all streams
   */
  clear(): void {
    if (this.items.size === 0) {
      return;
    }
    this.items.clear();
    this.persist();
  }

  /**
   * Clear content of a specific stream (but keep the stream)
   */
  clearContent(stream: StreamTabId): void {
    if (!this.has(stream)) {
      return;
    }

    const messages = this.ensureMessages(stream);
    messages.length = 0;
    this.persist();
  }

  getMessages(stream: StreamTabId): LogMessageData[] {
    return this.ensureMessages(stream);
  }

  get(stream: StreamTabId): LogMessageData[] | undefined {
    return this.items.get(stream);
  }

  has(stream: StreamTabId): boolean {
    return this.items.has(stream);
  }

  keys(): StreamTabId[] {
    return Array.from(this.items.keys());
  }

  getAll(): Map<StreamTabId, LogMessageData[]> {
    return new Map(this.items);
  }

  save(): void {
    this.persist();
  }

  private ensureMessages(stream: StreamTabId): LogMessageData[] {
    let messages = this.items.get(stream);
    if (!messages) {
      messages = [];
      this.items.set(stream, messages);
    }
    return messages;
  }

  /**
   * Load streams from persistence
   */
  async load(): Promise<void> {
    const saved = this.store.get<Record<string, LogMessageData[]>>(
      WorkspaceStateKey.STREAM_TABS,
      {},
    );

    this.items.clear();
    for (const [stream, messages] of Object.entries(saved ?? {})) {
      if (Array.isArray(messages)) {
        this.items.set(
          stream as StreamTabId,
          messages.map((entry) => ({ ...entry })),
        );
      }
    }

    if (this.items.size > 0) {
      this.logger.debug(`Loaded ${this.items.size} streams from storage`);
    }
  }

  private persist(): void {
    const serialized = Object.fromEntries(
      Array.from(this.items.entries(), ([stream, messages]) => [
        stream,
        messages.map((entry) => ({ ...entry })),
      ]),
    );
    void this.store.update(WorkspaceStateKey.STREAM_TABS, serialized);
  }
}
