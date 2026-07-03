import {
  STREAM_LOG_ENTRY_TYPES,
  type StreamLogEntry,
  type StreamLogTextDelta,
} from '@shared/schemas';
import { isObject } from '@utils/core';

export type StreamLogAppendInput = Omit<StreamLogEntry, 'seqNo'>;
export type StreamLogUpdatePatch = Partial<
  Omit<StreamLogEntry, 'id' | 'seqNo'>
>;

export function isRunningGroupEntry(entry: StreamLogEntry): boolean {
  if (entry.type !== STREAM_LOG_ENTRY_TYPES.GROUP_START) return false;
  const data = isObject(entry.data) ? entry.data : {};
  const status = typeof data.status === 'string' ? data.status : 'running';
  return status === 'running';
}

export class StreamLog {
  private entries: StreamLogEntry[] = [];
  private seqCounter = 0;
  private readonly indexById = new Map<string, number>();
  private readonly dirtyUpdates = new Set<string>();
  private readonly dirtyTextDeltas = new Map<string, StreamLogTextDelta>();
  private runningGroupCount = 0;

  constructor(entries: StreamLogEntry[] = []) {
    if (entries.length === 0) {
      return;
    }

    // Re-number seqNos sequentially (1-based) to close gaps from entries
    // that were filtered out by safeParse during schema upgrades.
    // This keeps the invariant: seqCounter === entries.length, which
    // getRange() relies on when using seqNo as an array-index proxy.
    this.entries = entries.map((entry, i) => {
      const seqNo = i + 1;
      return entry.seqNo === seqNo ? entry : { ...entry, seqNo };
    });
    this.seqCounter = this.entries.length;

    for (const [i, entry] of this.entries.entries()) {
      this.indexById.set(entry.id, i);
      if (isRunningGroupEntry(entry)) {
        this.runningGroupCount += 1;
      }
    }
  }

  get head(): number {
    return this.seqCounter;
  }

  get size(): number {
    return this.entries.length;
  }

  get firstTimestamp(): number | undefined {
    return this.entries[0]?.timestamp;
  }

  get lastTimestamp(): number | undefined {
    return this.entries.at(-1)?.timestamp;
  }

  get hasRunningGroup(): boolean {
    return this.runningGroupCount > 0;
  }

  append(entry: StreamLogAppendInput): StreamLogEntry {
    const fullEntry: StreamLogEntry = {
      ...entry,
      seqNo: this.seqCounter + 1,
    };
    this.seqCounter = fullEntry.seqNo;
    this.indexById.set(fullEntry.id, this.entries.length);
    this.entries.push(fullEntry);
    if (isRunningGroupEntry(fullEntry)) {
      this.runningGroupCount += 1;
    }
    return fullEntry;
  }

  update(id: string, patch: StreamLogUpdatePatch): StreamLogEntry | undefined {
    const index = this.indexById.get(id);
    if (index === undefined) return undefined;

    const current = this.entries[index];
    if (
      Object.entries(patch).every(([key, value]) =>
        Object.is(current[key as keyof StreamLogUpdatePatch], value),
      )
    ) {
      return undefined;
    }

    // Direct merge — no Zod parse. update() is on the streaming hot path
    // (tool output chunks at ~200/sec) and receives trusted data from
    // AgentTrace. Persisted entries are parsed when loaded from storage.
    const updated: StreamLogEntry = {
      ...current,
      ...patch,
      id: current.id,
      seqNo: current.seqNo,
    };

    const wasRunningGroup = isRunningGroupEntry(current);
    const isNowRunningGroup = isRunningGroupEntry(updated);
    if (wasRunningGroup && !isNowRunningGroup) {
      this.runningGroupCount -= 1;
    } else if (!wasRunningGroup && isNowRunningGroup) {
      this.runningGroupCount += 1;
    }

    this.entries[index] = updated;
    this.dirtyUpdates.add(id);
    this.dirtyTextDeltas.delete(id);
    return updated;
  }

  appendText(id: string, appendText: string): StreamLogEntry | undefined {
    if (appendText.length === 0) return undefined;

    const index = this.indexById.get(id);
    if (index === undefined) return undefined;

    const current = this.entries[index];
    if (current.type !== STREAM_LOG_ENTRY_TYPES.LOG) return undefined;

    const updated: StreamLogEntry = {
      ...current,
      text: `${current.text ?? ''}${appendText}`,
    };

    this.entries[index] = updated;
    if (!this.dirtyUpdates.has(id)) {
      const currentDelta = this.dirtyTextDeltas.get(id);
      this.dirtyTextDeltas.set(id, {
        id,
        appendText: `${currentDelta?.appendText ?? ''}${appendText}`,
      });
    }
    return updated;
  }

  getRange(fromSeq: number, toSeq: number = this.seqCounter): StreamLogEntry[] {
    const safeFrom = Math.max(0, fromSeq);
    const safeTo = Math.min(this.seqCounter, Math.max(safeFrom, toSeq));
    if (safeFrom >= safeTo) return [];
    return this.entries.slice(safeFrom, safeTo);
  }

  getDirtyUpdates(maxSeqInclusive: number = this.seqCounter): StreamLogEntry[] {
    const updates: StreamLogEntry[] = [];
    for (const id of this.dirtyUpdates) {
      const index = this.indexById.get(id);
      if (index === undefined) {
        this.dirtyUpdates.delete(id);
        continue;
      }
      const entry = this.entries[index];
      if (entry.seqNo <= maxSeqInclusive) {
        updates.push(entry);
      }
    }
    updates.sort((a, b) => a.seqNo - b.seqNo);
    return updates;
  }

  getDirtyTextDeltas(
    maxSeqInclusive: number = this.seqCounter,
  ): StreamLogTextDelta[] {
    const deltas: Array<{
      delta: StreamLogTextDelta;
      seqNo: number;
    }> = [];
    for (const [id, delta] of this.dirtyTextDeltas) {
      const index = this.indexById.get(id);
      if (index === undefined) {
        this.dirtyTextDeltas.delete(id);
        continue;
      }
      const entry = this.entries[index];
      if (entry.seqNo <= maxSeqInclusive) {
        deltas.push({ delta, seqNo: entry.seqNo });
      }
    }
    deltas.sort((a, b) => a.seqNo - b.seqNo);
    return deltas.map(({ delta }) => delta);
  }

  drainDirtyUpdates(
    maxSeqInclusive: number = this.seqCounter,
  ): StreamLogEntry[] {
    const updates = this.getDirtyUpdates(maxSeqInclusive);
    this.ackDirtyUpdates(updates);
    return updates;
  }

  clearDirtyUpdates(maxSeqInclusive: number = this.seqCounter): void {
    for (const id of this.dirtyUpdates) {
      const index = this.indexById.get(id);
      if (index === undefined) {
        this.dirtyUpdates.delete(id);
        continue;
      }
      if (this.entries[index].seqNo <= maxSeqInclusive) {
        this.dirtyUpdates.delete(id);
      }
    }

    for (const id of this.dirtyTextDeltas.keys()) {
      const index = this.indexById.get(id);
      if (index === undefined) {
        this.dirtyTextDeltas.delete(id);
        continue;
      }
      if (this.entries[index].seqNo <= maxSeqInclusive) {
        this.dirtyTextDeltas.delete(id);
      }
    }
  }

  ackDirtyUpdates(updates: readonly StreamLogEntry[]): void {
    for (const update of updates) {
      const index = this.indexById.get(update.id);
      if (index === undefined) {
        this.dirtyUpdates.delete(update.id);
        continue;
      }
      if (this.entries[index] === update) {
        this.dirtyUpdates.delete(update.id);
      }
    }
  }

  ackDirtyTextDeltas(
    deltas: readonly StreamLogTextDelta[],
    fullEntries: readonly StreamLogEntry[] = [],
  ): void {
    for (const entry of fullEntries) {
      const index = this.indexById.get(entry.id);
      if (index !== undefined && this.entries[index] === entry) {
        this.dirtyTextDeltas.delete(entry.id);
      }
    }

    for (const delta of deltas) {
      const current = this.dirtyTextDeltas.get(delta.id);
      if (!current) continue;

      if (current.appendText === delta.appendText) {
        this.dirtyTextDeltas.delete(delta.id);
        continue;
      }

      if (current.appendText.startsWith(delta.appendText)) {
        this.dirtyTextDeltas.set(delta.id, {
          id: delta.id,
          appendText: current.appendText.slice(delta.appendText.length),
        });
      }
    }
  }

  toJSON(): StreamLogEntry[] {
    return [...this.entries];
  }

  /**
   * Internal persistence view. Callers must treat the returned array as
   * immutable; avoiding a defensive copy matters on the stream-log save path.
   */
  toPersistedEntries(): readonly StreamLogEntry[] {
    return this.entries;
  }
}
