// Standard library imports
import { randomUUID } from 'crypto';

// Third-party imports
import { decode as decodeHtml } from 'he';

// Local imports - persistence
import { PersistentMapManager } from '../persistence/PersistentMapManager';
import { StatePersistenceManager } from '../persistence/StatePersistenceManager';

// Local imports - shared state and logging
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';
import { LogMessageData } from '@logger/LogTypes';

const LEGACY_MESSAGE_TYPES: ReadonlySet<LogMessageData['messageType']> =
  new Set([
    'fileList',
    'missingOutputs',
    'latexdiff',
    'statistics',
  ]);

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

  constructor(persistence: StatePersistenceManager) {
    super(persistence, WorkspaceStateKey.STREAM_TABS, 'texra.logStreams');
    this.logger = new AgentLogger('StreamTabsManager');
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
      if (log.data === undefined && typeof log.text === 'string') {
        if (log.messageType && LEGACY_MESSAGE_TYPES.has(log.messageType)) {
          try {
            const decoded = decodeHtml(log.text);
            const parsed = JSON.parse(decoded);
            if (typeof parsed === 'object' && parsed !== null) {
              log.data = parsed;
            }
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : String(error);
            this.logger.warn(`Failed to parse legacy log data: ${reason}`);
          }
        }
      }
      if (!log.messageType) {
        log.messageType = 'default';
      }
      return log;
    });
  }
}
