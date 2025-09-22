// Standard library imports
// Third-party imports
import { randomUUID } from 'crypto';

// Local imports - progress view

// Local imports
import { PersistentMapManager } from '../persistence/PersistentMapManager';
import { StatePersistenceManager } from '../persistence/StatePersistenceManager';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { WorkspaceStateKey } from '@common/state/stateManager';
import {
  createChannelLogger,
  parseLegacyLogData,
  type ChannelLogger,
} from '@logger/logUtils';

// Types
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
    if (!this.has(stream)) {
      this.items.set(stream, []);
    }

    const messages = this.get(stream)!;

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
      super.add(stream, []);
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
    if (this.has(stream)) {
      const arr = this.get(stream)!;
      arr.length = 0;
      this.save();
    }
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
    return messages.map((msg: any) => {
      if (!msg.id) {
        msg.id = randomUUID();
      }
      if (msg.text === undefined && msg.message !== undefined) {
        msg.text = msg.message;
      }
      if (msg.timestamp === undefined) {
        const attrMatch =
          typeof msg.text === 'string'
            ? msg.text.match(/data-full-timestamp="([^"]+)"/)
            : null;
        const timeString =
          attrMatch?.[1] ||
          (typeof msg.text === 'string'
            ? (msg.text.match(/\[(.*?)\]/)?.[1] ?? '')
            : '');
        const timestamp = new Date(timeString).getTime();
        msg.timestamp = isNaN(timestamp) ? Date.now() : timestamp;
      }
      const log = msg as LogMessageData;
      parseLegacyLogData(log, this.logger);
      if (!log.messageType) {
        log.messageType = 'default';
      }
      return log;
    });
  }
}
