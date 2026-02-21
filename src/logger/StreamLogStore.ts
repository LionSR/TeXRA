import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  StorageRecordSchema,
  STREAM_LOG_ENTRY_TYPES,
  StreamLogEntrySchema,
  type LogMessageData,
  type StreamLogEntry,
  type StreamTabId,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@common/state';
import type { MementoStorage } from '@progressView/persistence/PersistentMapManager';

import {
  StreamLog,
  type StreamLogAppendInput,
  type StreamLogUpdatePatch,
} from './StreamLog';

const SAVE_DEBOUNCE_MS = 300;

type StreamLogListener = (streamId: StreamTabId) => void;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class StreamLogStore {
  private readonly logs = new Map<StreamTabId, StreamLog>();
  private readonly listeners = new Set<StreamLogListener>();
  private storage: MementoStorage | undefined;

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingResolve: (() => void) | null = null;
  private savePromise: Promise<void> | null = null;
  private inFlightWrite: Promise<void> | null = null;

  constructor(storage?: MementoStorage) {
    this.storage = storage;
  }

  configureStorage(storage: MementoStorage): void {
    this.storage = storage;
  }

  onChange(listener: StreamLogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(streamId: StreamTabId): StreamLog | undefined {
    return this.logs.get(streamId);
  }

  has(streamId: StreamTabId): boolean {
    return this.logs.has(streamId);
  }

  keys(): StreamTabId[] {
    return [...this.logs.keys()];
  }

  ensureStream(streamId: StreamTabId): StreamLog {
    return this.getOrCreate(streamId);
  }

  append(streamId: StreamTabId, entry: StreamLogAppendInput): StreamLogEntry {
    const log = this.getOrCreate(streamId);
    const appended = log.append(entry);
    void this.save();
    this.notify(streamId);
    return appended;
  }

  update(
    streamId: StreamTabId,
    id: string,
    patch: StreamLogUpdatePatch,
  ): StreamLogEntry | undefined {
    const log = this.logs.get(streamId);
    if (!log) return undefined;

    const updated = log.update(id, patch);
    if (!updated) return undefined;

    void this.save();
    this.notify(streamId);
    return updated;
  }

  clearDirtyUpdates(streamId: StreamTabId): void {
    this.logs.get(streamId)?.clearDirtyUpdates();
  }

  getFirstTimestamp(streamId: StreamTabId): number | undefined {
    return this.logs.get(streamId)?.firstTimestamp;
  }

  getLastTimestamp(streamId: StreamTabId): number | undefined {
    return this.logs.get(streamId)?.lastTimestamp;
  }

  async delete(streamId: StreamTabId): Promise<void> {
    this.logs.delete(streamId);
    await this.persistNow();
  }

  async clear(): Promise<void> {
    this.logs.clear();
    await this.persistNow();
  }

  endRunningGroups(now: number = Date.now()): StreamTabId[] {
    const affected: StreamTabId[] = [];
    for (const [streamId, log] of this.logs.entries()) {
      let updatedAny = false;
      for (const entry of log.getRange(0, log.head)) {
        if (entry.type !== STREAM_LOG_ENTRY_TYPES.GROUP_START) continue;
        const existingData = isObject(entry.data) ? entry.data : {};
        const status =
          typeof existingData.status === 'string'
            ? existingData.status
            : 'running';
        if (status !== 'running') continue;

        const updated = log.update(entry.id, {
          type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
          data: { ...existingData, status: 'error', endTime: now },
        });
        if (updated) {
          updatedAny = true;
        }
      }

      if (updatedAny) {
        affected.push(streamId);
        this.notify(streamId);
      }
    }

    if (affected.length > 0) {
      void this.save();
    }

    return affected;
  }

  async load(): Promise<void> {
    if (!this.storage) return;

    this.logs.clear();
    const streamLogsRaw = this.storage.get(WorkspaceStateKey.STREAM_LOGS);
    const record = StorageRecordSchema.catch({}).parse(streamLogsRaw);

    if (Object.keys(record).length > 0) {
      for (const [streamId, rawEntries] of Object.entries(record)) {
        const entries = this.parsePersistedEntries(rawEntries);
        this.logs.set(streamId, new StreamLog(entries));
      }
      return;
    }

    this.loadLegacyStreamTabs();
  }

  async save(): Promise<void> {
    if (!this.storage) return;

    if (this.saveTimer !== null) clearTimeout(this.saveTimer);

    if (!this.savePromise || this.pendingResolve === null) {
      this.savePromise = new Promise<void>((resolve) => {
        this.pendingResolve = resolve;
      });
    }

    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      this.executeWrite(resolve);
    }, SAVE_DEBOUNCE_MS);

    return this.savePromise;
  }

  async flush(): Promise<void> {
    if (!this.storage) return;

    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      await this.executeWrite(resolve);
      return;
    }

    if (this.inFlightWrite) {
      await this.inFlightWrite;
    }
  }

  private getOrCreate(streamId: StreamTabId): StreamLog {
    let log = this.logs.get(streamId);
    if (!log) {
      log = new StreamLog();
      this.logs.set(streamId, log);
    }
    return log;
  }

  private notify(streamId: StreamTabId): void {
    for (const listener of this.listeners) {
      listener(streamId);
    }
  }

  private parsePersistedEntries(rawEntries: unknown): StreamLogEntry[] {
    if (!Array.isArray(rawEntries)) return [];

    const entries: StreamLogEntry[] = [];
    for (const rawEntry of rawEntries) {
      const parsed = StreamLogEntrySchema.safeParse(rawEntry);
      if (parsed.success) {
        entries.push(parsed.data);
      }
    }
    return entries;
  }

  private loadLegacyStreamTabs(): void {
    if (!this.storage) return;

    const legacyRaw = this.storage.get(WorkspaceStateKey.STREAM_TABS);
    const legacyRecord = StorageRecordSchema.catch({}).parse(legacyRaw);

    for (const [streamId, rawMessages] of Object.entries(legacyRecord)) {
      if (!Array.isArray(rawMessages)) continue;
      const entries: StreamLogEntry[] = [];
      let seqNo = 0;

      for (const rawMessage of rawMessages) {
        if (!isObject(rawMessage)) continue;
        const message = rawMessage as Partial<LogMessageData>;
        if (
          typeof message.id !== 'string' ||
          typeof message.text !== 'string' ||
          typeof message.timestamp !== 'number'
        ) {
          continue;
        }

        seqNo += 1;
        entries.push(
          StreamLogEntrySchema.parse({
            seqNo,
            id: message.id,
            type: STREAM_LOG_ENTRY_TYPES.LOG,
            level: message.level ?? LOG_LEVELS.INFO,
            timestamp: message.timestamp,
            groupId: message.groupId,
            messageType: message.messageType ?? MESSAGE_TYPES.DEFAULT,
            text: message.text,
            verbose: message.verbose,
            data: message.data,
          }),
        );
      }

      this.logs.set(streamId, new StreamLog(entries));
    }

    if (this.logs.size > 0) {
      void this.persistNow();
    }
  }

  private async persistNow(): Promise<void> {
    if (!this.storage) return;

    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    this.pendingResolve = null;
    this.savePromise = null;
    await this.executeWrite(null);
  }

  private executeWrite(resolve: (() => void) | null): Promise<void> {
    if (!this.storage) {
      resolve?.();
      return Promise.resolve();
    }

    const record: Record<string, StreamLogEntry[]> = {};
    for (const [streamId, log] of this.logs.entries()) {
      record[streamId] = log.toJSON();
    }

    const writePromise = Promise.resolve(
      this.storage.update(WorkspaceStateKey.STREAM_LOGS, record),
    )
      .catch(() => {
        // Keep writes non-throwing on hot path.
      })
      .finally(() => {
        if (this.inFlightWrite === writePromise) {
          this.inFlightWrite = null;
          if (!this.pendingResolve) {
            this.savePromise = null;
          }
        }
        resolve?.();
      });

    this.inFlightWrite = writePromise;
    return writePromise;
  }
}

let defaultStore: StreamLogStore | undefined;

export function getDefaultStreamLogStore(): StreamLogStore {
  defaultStore ??= new StreamLogStore();
  return defaultStore;
}

export function setDefaultStreamLogStore(store: StreamLogStore): void {
  defaultStore = store;
}
