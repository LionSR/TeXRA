import { StreamLogEntrySchema, type StreamLogEntry } from '@shared/schemas';

export type StreamLogAppendInput = Omit<StreamLogEntry, 'seqNo'>;
export type StreamLogUpdatePatch = Partial<
  Omit<StreamLogEntry, 'id' | 'seqNo'>
>;

export class StreamLog {
  private entries: StreamLogEntry[] = [];
  private seqCounter = 0;
  private readonly indexById = new Map<string, number>();
  private readonly dirtyUpdates = new Set<string>();

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

    for (let i = 0; i < this.entries.length; i++) {
      this.indexById.set(this.entries[i].id, i);
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

  append(entry: StreamLogAppendInput): StreamLogEntry {
    const fullEntry = StreamLogEntrySchema.parse({
      ...entry,
      seqNo: this.seqCounter + 1,
    });
    this.seqCounter = fullEntry.seqNo;
    this.indexById.set(fullEntry.id, this.entries.length);
    this.entries.push(fullEntry);
    return fullEntry;
  }

  update(id: string, patch: StreamLogUpdatePatch): StreamLogEntry | undefined {
    const index = this.indexById.get(id);
    if (index === undefined) return undefined;

    const current = this.entries[index];
    // Direct merge — no Zod parse. update() is on the streaming hot path
    // (tool output chunks at ~200/sec) and receives trusted data from
    // AgentLogger. The schema boundary is append(), not update().
    const updated: StreamLogEntry = {
      ...current,
      ...patch,
      id: current.id,
      seqNo: current.seqNo,
    };

    this.entries[index] = updated;
    this.dirtyUpdates.add(id);
    return updated;
  }

  getRange(fromSeq: number, toSeq: number = this.seqCounter): StreamLogEntry[] {
    const safeFrom = Math.max(0, fromSeq);
    const safeTo = Math.min(this.seqCounter, Math.max(safeFrom, toSeq));
    if (safeFrom >= safeTo) return [];
    return this.entries.slice(safeFrom, safeTo);
  }

  drainDirtyUpdates(
    maxSeqInclusive: number = this.seqCounter,
  ): StreamLogEntry[] {
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
        this.dirtyUpdates.delete(id);
      }
    }
    updates.sort((a, b) => a.seqNo - b.seqNo);
    return updates;
  }

  clearDirtyUpdates(): void {
    this.dirtyUpdates.clear();
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
