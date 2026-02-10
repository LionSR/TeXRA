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

/** Debounce interval for persistence writes (ms). */
const SAVE_DEBOUNCE_MS = 300;

/**
 * Manages stream tabs collection with persistence.
 * Handles adding, retrieving, and managing log messages for different streams.
 *
 * Overrides save() with a 300ms trailing-edge debounce because log messages
 * arrive at ~10Hz during streaming. In-memory state is always immediately
 * up-to-date; only the disk write is deferred and coalesced.
 */
export class StreamTabsManager extends PersistentMapManager<
  StreamTabId,
  LogMessageData[]
> {
  private static readonly MAX_MESSAGE_HISTORY = 1000;
  private readonly logger: AgentLogger;

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingResolve: (() => void) | null = null;

  constructor(storage?: MementoStorage) {
    super(WorkspaceStateKey.STREAM_TABS, storage);
    this.logger = new AgentLogger('StreamTabsManager');
  }

  /**
   * Add a log message to a stream.
   * Returns true if message was added, false if it updated an existing message.
   *
   * Uses fire-and-forget persistence (void this.save()) so callers can
   * send webview notifications immediately without waiting for disk I/O.
   */
  addMessage(stream: StreamTabId, message: LogMessageData): boolean {
    const messages = this.ensureMessages(stream);

    const existingIndex = messages.findIndex(
      (entry) => entry.id === message.id,
    );

    // Update existing message
    if (existingIndex >= 0) {
      messages[existingIndex] = message;
      void this.save();
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

    void this.save();
    return true;
  }

  /**
   * Create an empty stream if it doesn't exist
   */
  ensureStream(stream: StreamTabId): void {
    if (!this.has(stream)) {
      this.ensureMessages(stream);
      void this.save();
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
   * Returns the original message (before update) if found, undefined otherwise.
   * Callers can use the return value both as a found/not-found check and to
   * access the pre-update state (e.g. for constructing webview messages).
   *
   * Optional guard predicate runs against the existing message BEFORE mutation.
   * Returns undefined (no mutation) if the guard returns false.
   *
   * Uses fire-and-forget persistence (void this.save()) because the in-memory
   * state is immediately correct for webview updates.
   */
  updateMessage(
    stream: StreamTabId,
    messageId: string,
    updates: Partial<Omit<LogMessageData, 'id'>>,
    guard?: (existing: LogMessageData) => boolean,
  ): LogMessageData | undefined {
    const messages = this.items.get(stream);
    if (!messages) return undefined;

    const index = messages.findIndex((m) => m.id === messageId);
    if (index < 0) return undefined;

    const original = messages[index];
    if (guard && !guard(original)) return undefined;
    messages[index] = { ...original, ...updates };
    void this.save();
    return original;
  }

  /**
   * Debounced save — coalesces rapid-fire log mutations into a single write.
   * When a new save supersedes a pending one, the previous promise is
   * resolved immediately (its data is captured by the newer write).
   */
  override async save(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
    }

    this.pendingResolve?.();

    return new Promise<void>((resolve) => {
      this.pendingResolve = resolve;
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.pendingResolve = null;
        this.writeToStorage().then(resolve, resolve);
      }, SAVE_DEBOUNCE_MS);
    });
  }

  /**
   * Flush any pending debounced write immediately.
   * Called during dispose/shutdown to prevent data loss.
   */
  override async flush(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.pendingResolve?.();
      this.pendingResolve = null;
      await this.writeToStorage();
    }
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
