// Local imports - shared state and logging
import type { StreamTabId } from '@agent/types/IdentifierTypes';

// Internal imports
import { WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';
import { LogMessageData } from '@logger/LogTypes';
import {
  PersistentMapManager,
  type StateStorage,
} from '@progressView/persistence/PersistentMapManager';

/**
 * Manages stream tabs collection with persistence.
 * Handles adding, retrieving, and managing log messages for different streams.
 *
 * Performance: Uses a secondary index (messageIdIndex) for O(1) message lookups
 * instead of O(n) array scans. This is critical when handling thousands of messages.
 */
export class StreamTabsManager extends PersistentMapManager<
  StreamTabId,
  LogMessageData[]
> {
  private static readonly MAX_MESSAGE_HISTORY = 1000;
  private readonly logger: AgentLogger;

  /**
   * Secondary index: messageId → { stream, index in messages array }
   * Enables O(1) lookups and updates instead of O(n) findIndex calls.
   */
  private readonly messageIdIndex = new Map<
    string,
    { stream: StreamTabId; index: number }
  >();

  constructor(storage?: StateStorage) {
    super(WorkspaceStateKey.STREAM_TABS, storage);
    this.logger = new AgentLogger('StreamTabsManager');
  }

  /**
   * Add a log message to a stream.
   * Returns true if message was added, false if it updated an existing message.
   *
   * Performance: Uses messageIdIndex for O(1) lookup instead of O(n) findIndex.
   */
  async addMessage(
    stream: StreamTabId,
    message: LogMessageData,
  ): Promise<boolean> {
    const messages = this.ensureMessages(stream);

    // O(1) lookup using index
    const indexed = this.messageIdIndex.get(message.id);

    // Update existing message
    if (indexed && indexed.stream === stream) {
      messages[indexed.index] = message;
      await this.save();
      return false;
    }

    // Add new message
    const newIndex = messages.length;
    messages.push(message);
    this.messageIdIndex.set(message.id, { stream, index: newIndex });

    // Limit message history to prevent memory issues
    if (messages.length > StreamTabsManager.MAX_MESSAGE_HISTORY) {
      const removeCount =
        messages.length - StreamTabsManager.MAX_MESSAGE_HISTORY;
      // Remove oldest messages from index
      for (let i = 0; i < removeCount; i++) {
        const oldMsg = messages[i];
        if (oldMsg?.id) {
          this.messageIdIndex.delete(oldMsg.id);
        }
      }
      messages.splice(0, removeCount);
      // Rebuild index for remaining messages (indices shifted)
      this.rebuildStreamIndex(stream, messages);
    }

    await this.save();
    return true;
  }

  /**
   * Rebuild the message ID index for a specific stream.
   * Called after array mutations that shift indices (splice, etc.)
   */
  private rebuildStreamIndex(
    stream: StreamTabId,
    messages: LogMessageData[],
  ): void {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg?.id) {
        this.messageIdIndex.set(msg.id, { stream, index: i });
      }
    }
  }

  /**
   * Create an empty stream if it doesn't exist
   */
  async ensureStream(stream: StreamTabId): Promise<void> {
    if (!this.has(stream)) {
      this.ensureMessages(stream);
      await this.save();
    }
  }

  /**
   * Get a copy of messages for a stream (safe for external use).
   * Returns a shallow copy to prevent external mutation of internal state.
   */
  getMessages(stream: StreamTabId): LogMessageData[] {
    return [...this.ensureMessages(stream)];
  }

  /**
   * Get first timestamp for a stream (for sorting by creation time).
   * More efficient than getMessages() when only timestamp is needed.
   */
  getFirstTimestamp(stream: StreamTabId): number | undefined {
    const messages = this.items.get(stream);
    return messages?.[0]?.timestamp;
  }

  /**
   * Get last timestamp for a stream (for sorting by last activity).
   * More efficient than getMessages() when only timestamp is needed.
   */
  getLastTimestamp(stream: StreamTabId): number | undefined {
    const messages = this.items.get(stream);
    return messages?.at(-1)?.timestamp;
  }

  /**
   * Update an existing message by ID.
   * Returns true if message was found and updated, false otherwise.
   *
   * Performance: Uses messageIdIndex for O(1) lookup instead of O(n) findIndex.
   *
   * Note: Uses fire-and-forget persistence (void this.save()) because:
   * - Callers only need to know if message was found/updated in memory
   * - The in-memory state is immediately correct for webview updates
   * - Persistence is background work; failures are logged by base class
   */
  updateMessage(
    stream: StreamTabId,
    messageId: string,
    updates: Partial<Omit<LogMessageData, 'id'>>,
  ): boolean {
    const messages = this.items.get(stream);
    if (!messages) return false;

    // O(1) lookup using index
    const indexed = this.messageIdIndex.get(messageId);
    if (!indexed || indexed.stream !== stream) return false;

    const index = indexed.index;
    if (index < 0 || index >= messages.length) return false;

    messages[index] = { ...messages[index], ...updates };
    void this.save();
    return true;
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
   * Load streams from persistence and rebuild the message ID index.
   */
  async load(): Promise<void> {
    await super.load();

    // Rebuild the entire message ID index from loaded data
    this.messageIdIndex.clear();
    for (const [stream, messages] of this.items) {
      this.rebuildStreamIndex(stream, messages);
    }

    if (this.items.size > 0) {
      this.logger.debug(`Loaded ${this.items.size} streams from storage`);
    }
  }

  /** Normalize loaded messages with shallow copies for independence */
  protected override deserialize(
    data: unknown,
    _key: StreamTabId,
  ): LogMessageData[] {
    if (!Array.isArray(data)) {
      return [];
    }
    return data.map((entry) => ({ ...entry })) as LogMessageData[];
  }

  /**
   * Override delete to clean up the message ID index.
   */
  override async delete(key: StreamTabId): Promise<void> {
    // Remove all message IDs for this stream from the index
    const messages = this.items.get(key);
    if (messages) {
      for (const msg of messages) {
        if (msg?.id) {
          this.messageIdIndex.delete(msg.id);
        }
      }
    }
    await super.delete(key);
  }

  /**
   * Override clear to clean up the message ID index.
   */
  override async clear(): Promise<void> {
    this.messageIdIndex.clear();
    await super.clear();
  }
}
