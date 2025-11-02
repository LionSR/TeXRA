// Standard library imports
import { randomUUID } from 'crypto';

// Local imports - persistence
import { PersistentMapManager } from '../persistence/PersistentMapManager';
import { StatePersistenceManager } from '../persistence/StatePersistenceManager';

// Local imports - shared state and logging
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { WorkspaceStateKey } from '@common/state/stateManager';
import { createChannelLogger, type ChannelLogger } from '@logger/logUtils';
import { LogMessageData } from '@logger/LogTypes';

/**
 * Manages stream tabs collection with persistence.
 * Handles adding, retrieving, and managing log messages for different streams.
 */
export class StreamTabsManager extends PersistentMapManager<
  StreamTabId,
  LogMessageData[]
> {
  private static readonly MAX_MESSAGE_HISTORY = 1000;
  private readonly logger: ChannelLogger;

  constructor(persistence: StatePersistenceManager) {
    super(persistence, WorkspaceStateKey.STREAM_TABS, 'texra.logStreams');
    this.logger = createChannelLogger('StreamTabsManager');
  }

  /**
   * Add a log message to a stream
   */
  addMessage(stream: StreamTabId, message: LogMessageData): void {
    const messages = this.ensureMessages(stream);

    // Ensure message has required fields
    if (!message.id) {
      message.id = randomUUID();
    }

    messages.push(message);

    // Limit message history to prevent memory issues
    if (messages.length > StreamTabsManager.MAX_MESSAGE_HISTORY) {
      messages.splice(
        0,
        messages.length - StreamTabsManager.MAX_MESSAGE_HISTORY,
      );
    }

    this.save();
  }

  /**
   * Create an empty stream if it doesn't exist
   */
  ensureStream(stream: StreamTabId): void {
    if (!this.has(stream)) {
      this.ensureMessages(stream);
      this.save();
    }
  }

  /**
   * Delete a stream and its messages
   */
  delete(stream: StreamTabId): void {
    super.delete(stream);
  }

  /**
   * Clear all streams
   */
  clear(): void {
    super.clear();
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
    this.save();
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
      this.logger.debug(`Loaded ${this.items.size} streams from storage`);
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
    const messages = Array.isArray(data) ? data : [];
    return messages.map((raw) => {
      const message = raw as Partial<LogMessageData> & {
        message?: string;
      };

      const rawTimestamp = message.timestamp;
      let timestamp = Date.now();
      if (typeof rawTimestamp === 'number') {
        timestamp = rawTimestamp;
      } else if (typeof rawTimestamp === 'string') {
        const numeric = Number(rawTimestamp);
        if (!Number.isNaN(numeric)) {
          timestamp = numeric;
        }
      }

      const text =
        typeof message.text === 'string'
          ? message.text
          : typeof message.message === 'string'
            ? message.message
            : '';

      return {
        id:
          typeof message.id === 'string' && message.id
            ? message.id
            : randomUUID(),
        text,
        level: message.level ?? 'info',
        timestamp,
        messageType: message.messageType ?? 'default',
        data: message.data,
        groupId: message.groupId,
        verbose: message.verbose,
      } satisfies LogMessageData;
    });
  }
}
