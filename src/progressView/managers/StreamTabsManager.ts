// Third-party imports
import { randomUUID } from 'crypto';

// Local imports
import { StatePersistenceManager } from '../persistence/StatePersistenceManager';
import { WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';
import { parseLegacyLogData } from '@logger/logUtils';

// Types
import { LogMessageData } from '@logger/LogTypes';
import type { StreamTabId } from '@agent/types/IdentifierTypes';

/**
 * Manages stream tabs collection with persistence.
 * Handles adding, retrieving, and managing log messages for different streams.
 */
export class StreamTabsManager {
  private _tabs: Map<StreamTabId, LogMessageData[]> = new Map();
  private readonly logger: AgentLogger;

  constructor(private persistence: StatePersistenceManager) {
    this.logger = new AgentLogger('StreamTabsManager');
  }

  /**
   * Add a log message to a stream
   */
  add(stream: StreamTabId, message: LogMessageData): void {
    if (!this._tabs.has(stream)) {
      this._tabs.set(stream, []);
    }

    const messages = this._tabs.get(stream)!;

    // Ensure message has required fields
    if (!message.id) {
      message.id = randomUUID();
    }

    messages.push(message);

    // Limit message history to prevent memory issues
    if (messages.length > 1000) {
      messages.splice(0, messages.length - 1000);
    }

    this.save();
  }

  /**
   * Get messages for a stream
   */
  get(stream: StreamTabId): LogMessageData[] | undefined {
    return this._tabs.get(stream);
  }

  /**
   * Check if stream exists
   */
  has(stream: StreamTabId): boolean {
    return this._tabs.has(stream);
  }

  /**
   * Create an empty stream if it doesn't exist
   */
  ensureStream(stream: StreamTabId): void {
    if (!this._tabs.has(stream)) {
      this._tabs.set(stream, []);
      this.save();
    }
  }

  /**
   * Delete a stream and its messages
   */
  delete(stream: StreamTabId): void {
    this._tabs.delete(stream);
    this.save();
  }

  /**
   * Clear all streams
   */
  clear(): void {
    this._tabs.clear();
    this.save();
  }

  /**
   * Clear content of a specific stream (but keep the stream)
   */
  clearContent(stream: StreamTabId): void {
    if (this._tabs.has(stream)) {
      this._tabs.get(stream)!.length = 0;
      this.save();
    }
  }

  /**
   * Get all stream IDs
   */
  keys(): StreamTabId[] {
    return Array.from(this._tabs.keys());
  }

  /**
   * Get all streams as Map
   */
  getAll(): Map<StreamTabId, LogMessageData[]> {
    return new Map(this._tabs);
  }

  /**
   * Set streams (used during loading)
   */
  setAll(streams: Map<StreamTabId, LogMessageData[]>): void {
    this._tabs = new Map(streams);
  }

  /**
   * Load streams from persistence
   */
  async load(): Promise<void> {
    const savedState = await this.persistence.loadWithMigration<{
      [key: string]: LogMessageData[] | any[];
    }>(WorkspaceStateKey.STREAM_TABS, 'texra.logStreams', {});

    if (savedState && Object.keys(savedState).length > 0) {
      const processedStreams = new Map<StreamTabId, LogMessageData[]>();

      for (const [stream, messages] of Object.entries(savedState)) {
        const processedMessages = messages.map((msg: any) => {
          // Ensure message has required fields
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

        processedStreams.set(stream, processedMessages);
      }

      this._tabs = processedStreams;
      this.logger.debug(`Loaded ${this._tabs.size} streams from storage`);
    } else {
      this._tabs.clear();
    }
  }

  /**
   * Save streams to persistence
   */
  save(): void {
    const stateObj = Object.fromEntries(this._tabs.entries());
    this.persistence.save(WorkspaceStateKey.STREAM_TABS, stateObj);
  }
}
