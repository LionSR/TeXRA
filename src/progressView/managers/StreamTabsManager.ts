// Local imports - shared state and logging
import type { StreamTabId } from '@agent/types/IdentifierTypes';

// Internal imports
import { WorkspaceStateKey } from '@common/state/stateManager';
import { LogMessageData } from '@logger/LogTypes';
import { progressViewLogger } from '@progressView/progressViewLogger';
import {
  PersistentMapManager,
  type StateStorage,
} from '@progressView/persistence/PersistentMapManager';

/**
 * Manages stream tabs collection with persistence.
 * Handles adding, retrieving, and managing log messages for different streams.
 */
export class StreamTabsManager extends PersistentMapManager<
  StreamTabId,
  LogMessageData[]
> {
  private static readonly MAX_MESSAGE_HISTORY = 1000;

  constructor(storage?: StateStorage) {
    super(WorkspaceStateKey.STREAM_TABS, storage, ['texra.logStreams']);
  }

  /**
   * Add a log message to a stream
   */
  async addMessage(
    stream: StreamTabId,
    message: LogMessageData,
  ): Promise<boolean> {
    const messages = this.ensureMessages(stream);

    const existingIndex = messages.findIndex(
      (entry) => entry.id === message.id,
    );
    if (existingIndex >= 0) {
      messages[existingIndex] = message;
      await this.save();
      return false;
    } else {
      messages.push(message);
    }

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
   * Clear content of a specific stream (but keep the stream)
   */
  async clearContent(stream: StreamTabId): Promise<void> {
    if (!this.has(stream)) {
      return;
    }

    const messages = this.ensureMessages(stream);
    messages.length = 0;
    await this.save();
  }

  getMessages(stream: StreamTabId): LogMessageData[] {
    return this.ensureMessages(stream);
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
    await super.load();
    if (this.items.size > 0) {
      progressViewLogger.debug(
        `Loaded ${this.items.size} streams from storage`,
      );
    }
  }

  /** Serialize messages before saving */
  protected override serialize(
    value: LogMessageData[],
    _key: StreamTabId,
  ): unknown {
    return value;
  }

  /** Normalize loaded messages */
  protected override async deserialize(
    data: unknown,
    _key: StreamTabId,
  ): Promise<LogMessageData[]> {
    if (!Array.isArray(data)) {
      return [];
    }

    return data.map((entry) => ({ ...entry })) as LogMessageData[];
  }
}
