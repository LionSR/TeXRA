import {
  LogMessageDataSchema,
  type LogMessageData,
  type StreamTabId,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';
import {
  PersistentMapManager,
  type MementoStorage,
} from '@progressView/persistence/PersistentMapManager';
import { createArraySchema } from '@progressView/persistence/schemaUtils';

/** Schema for deserializing persisted log messages */
const LogMessagesSchema = createArraySchema(LogMessageDataSchema);

/**
 * Manages stream tabs collection with persistence.
 * Handles adding, retrieving, and managing log messages for different streams.
 */
export class StreamTabsManager extends PersistentMapManager<
  StreamTabId,
  LogMessageData[]
> {
  private static readonly MAX_MESSAGE_HISTORY = 1000;
  private readonly logger: AgentLogger;

  constructor(storage?: MementoStorage) {
    super(WorkspaceStateKey.STREAM_TABS, storage);
    this.logger = new AgentLogger('StreamTabsManager');
  }

  /**
   * Add a log message to a stream.
   * Returns true if message was added, false if it updated an existing message.
   */
  async addMessage(
    stream: StreamTabId,
    message: LogMessageData,
  ): Promise<boolean> {
    const messages = this.ensureMessages(stream);

    const existingIndex = messages.findIndex(
      (entry) => entry.id === message.id,
    );

    // Update existing message
    if (existingIndex >= 0) {
      messages[existingIndex] = message;
      await this.save();
      return false;
    }

    // Add new message
    messages.push(message);

    // Limit message history to prevent memory issues
    if (messages.length > StreamTabsManager.MAX_MESSAGE_HISTORY) {
      messages.splice(
        0,
        messages.length - StreamTabsManager.MAX_MESSAGE_HISTORY,
      );
    }

    await this.save();
    return true;
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

    const index = messages.findIndex((m) => m.id === messageId);
    if (index < 0) return false;

    messages[index] = { ...messages[index], ...updates };
    void this.save();
    return true;
  }

  private ensureMessages(stream: StreamTabId): LogMessageData[] {
    return this.getOrCreate(stream, () => []);
  }

  /**
   * Load streams from persistence
   */
  async load(): Promise<void> {
    await super.load();
    if (this.items.size > 0) {
      this.logger.debug(`Loaded ${this.items.size} streams from storage`);
    }
  }

  /** Normalize loaded messages with schema validation */
  protected override deserialize(
    data: unknown,
    _key: StreamTabId,
  ): LogMessageData[] {
    return LogMessagesSchema.parse(data);
  }
}
