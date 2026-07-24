import {
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  STREAMING_TEXT_MESSAGE_TYPES,
  WorkflowTaskProgressSchema,
  isTerminalWorkflowTaskProgress,
  type StreamLogEntry,
  type StreamLogTextDelta,
} from '@shared/schemas';
import { isObject } from '@utils/core';

export type StreamLogAppendInput = Omit<
  StreamLogEntry,
  'seqNo' | 'settlementSeqNo'
>;
export type StreamLogUpdatePatch = Partial<
  Omit<StreamLogEntry, 'id' | 'seqNo' | 'settlementSeqNo'>
>;

export interface StreamLogPreservedRawEntry {
  readonly beforeTypedIndex: number;
  readonly raw: unknown;
}

export function isRunningGroupEntry(entry: StreamLogEntry): boolean {
  if (entry.type !== STREAM_LOG_ENTRY_TYPES.GROUP_START) return false;
  const data = isObject(entry.data) ? entry.data : {};
  const status = typeof data.status === 'string' ? data.status : 'running';
  return status === 'running';
}

/**
 * True while a thinking/scratchpad/model-response entry is at
 * `data.status: 'running'` — either genuinely still streaming, or orphaned
 * because its stream never got a `stream.end` (run cancelled, crashed, or
 * the host reloaded mid-stream). Used both for live in-memory tracking
 * (`hasRunningStreamingText`) and, by the same predicate, to identify
 * orphaned entries at load time in `StreamLogStore`'s recovery sweep.
 */
export function isRunningStreamingTextEntry(entry: StreamLogEntry): boolean {
  if (entry.type !== STREAM_LOG_ENTRY_TYPES.LOG) return false;
  if (!STREAMING_TEXT_MESSAGE_TYPES.has(entry.messageType ?? '')) return false;
  const data = isObject(entry.data) ? entry.data : {};
  return data.status === 'running';
}

export function isNonterminalWorkflowTaskEntry(entry: StreamLogEntry): boolean {
  if (
    entry.type !== STREAM_LOG_ENTRY_TYPES.LOG ||
    entry.messageType !== MESSAGE_TYPES.WORKFLOW_TASK
  ) {
    return false;
  }
  const task = WorkflowTaskProgressSchema.safeParse(entry.data);
  return task.success && !isTerminalWorkflowTaskProgress(task.data);
}

export class StreamLog {
  private entries: StreamLogEntry[] = [];
  private readonly preservedRawEntries: StreamLogPreservedRawEntry[] = [];
  private seqCounter = 0;
  private readonly indexById = new Map<string, number>();
  private readonly dirtyUpdates = new Set<string>();
  private readonly dirtyTextDeltas = new Map<string, StreamLogTextDelta>();
  private settlementSeqCounter = 0;
  private runningGroupCount = 0;
  private runningStreamingTextCount = 0;
  private nonterminalWorkflowTaskCount = 0;

  constructor(
    entries: readonly StreamLogEntry[] = [],
    preservedRawEntries: readonly StreamLogPreservedRawEntry[] = [],
  ) {
    this.preservedRawEntries = [...preservedRawEntries];

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
    this.settlementSeqCounter = Math.max(
      this.entries.length,
      ...this.entries.map((entry) => entry.settlementSeqNo ?? 0),
    );

    for (const [i, entry] of this.entries.entries()) {
      this.indexById.set(entry.id, i);
      if (isRunningGroupEntry(entry)) {
        this.runningGroupCount += 1;
      }
      if (isRunningStreamingTextEntry(entry)) {
        this.runningStreamingTextCount += 1;
      }
      if (isNonterminalWorkflowTaskEntry(entry)) {
        this.nonterminalWorkflowTaskCount += 1;
      }
    }
  }

  get head(): number {
    return this.seqCounter;
  }

  get size(): number {
    return this.entries.length;
  }

  /** Latest durable append-only transcript order allocated by this stream. */
  get settlementHead(): number {
    return this.settlementSeqCounter;
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

  /** True while any thinking/scratchpad/model-response entry is still at `data.status: 'running'`. */
  get hasRunningStreamingText(): boolean {
    return this.runningStreamingTextCount > 0;
  }

  get hasNonterminalWorkflowTask(): boolean {
    return this.nonterminalWorkflowTaskCount > 0;
  }

  append(entry: StreamLogAppendInput): StreamLogEntry {
    return this.appendWithSettlement(entry, false);
  }

  appendSettled(entry: StreamLogAppendInput): StreamLogEntry {
    return this.appendWithSettlement(entry, true);
  }

  private appendWithSettlement(
    entry: StreamLogAppendInput,
    settled: boolean,
  ): StreamLogEntry {
    const fullEntry: StreamLogEntry = {
      ...entry,
      seqNo: this.seqCounter + 1,
      ...(settled ? { settlementSeqNo: this.settlementSeqCounter + 1 } : {}),
    };
    this.seqCounter = fullEntry.seqNo;
    if (settled) this.settlementSeqCounter += 1;
    this.indexById.set(fullEntry.id, this.entries.length);
    this.entries.push(fullEntry);
    if (isRunningGroupEntry(fullEntry)) {
      this.runningGroupCount += 1;
    }
    if (isRunningStreamingTextEntry(fullEntry)) {
      this.runningStreamingTextCount += 1;
    }
    if (isNonterminalWorkflowTaskEntry(fullEntry)) {
      this.nonterminalWorkflowTaskCount += 1;
    }
    return fullEntry;
  }

  update(id: string, patch: StreamLogUpdatePatch): StreamLogEntry | undefined {
    return this.updateWithSettlement(id, patch, false);
  }

  settle(id: string, patch: StreamLogUpdatePatch): StreamLogEntry | undefined {
    return this.updateWithSettlement(id, patch, true);
  }

  private updateWithSettlement(
    id: string,
    patch: StreamLogUpdatePatch,
    settle: boolean,
  ): StreamLogEntry | undefined {
    const index = this.indexById.get(id);
    if (index === undefined) return undefined;

    const current = this.entries[index];
    const settlementSeqNo =
      settle && current.settlementSeqNo === undefined
        ? this.settlementSeqCounter + 1
        : current.settlementSeqNo;
    if (
      settlementSeqNo === current.settlementSeqNo &&
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
      ...(settlementSeqNo !== undefined ? { settlementSeqNo } : {}),
    };
    if (settlementSeqNo !== current.settlementSeqNo) {
      this.settlementSeqCounter += 1;
    }

    const wasRunningGroup = isRunningGroupEntry(current);
    const isNowRunningGroup = isRunningGroupEntry(updated);
    if (wasRunningGroup && !isNowRunningGroup) {
      this.runningGroupCount -= 1;
    } else if (!wasRunningGroup && isNowRunningGroup) {
      this.runningGroupCount += 1;
    }

    const wasRunningStreamingText = isRunningStreamingTextEntry(current);
    const isNowRunningStreamingText = isRunningStreamingTextEntry(updated);
    if (wasRunningStreamingText && !isNowRunningStreamingText) {
      this.runningStreamingTextCount -= 1;
    } else if (!wasRunningStreamingText && isNowRunningStreamingText) {
      this.runningStreamingTextCount += 1;
    }

    const wasNonterminalWorkflowTask = isNonterminalWorkflowTaskEntry(current);
    const isNowNonterminalWorkflowTask =
      isNonterminalWorkflowTaskEntry(updated);
    if (wasNonterminalWorkflowTask && !isNowNonterminalWorkflowTask) {
      this.nonterminalWorkflowTaskCount -= 1;
    } else if (!wasNonterminalWorkflowTask && isNowNonterminalWorkflowTask) {
      this.nonterminalWorkflowTaskCount += 1;
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
      if (index === undefined) {
        this.dirtyTextDeltas.delete(entry.id);
        continue;
      }

      if (this.entries[index] === entry) {
        this.dirtyTextDeltas.delete(entry.id);
        continue;
      }

      const current = this.dirtyTextDeltas.get(entry.id);
      if (!current) continue;
      const currentEntry = this.entries[index];
      const currentText =
        typeof currentEntry.text === 'string' ? currentEntry.text : '';
      const deliveredText = typeof entry.text === 'string' ? entry.text : '';
      // A full-entry frame covers all appended text between the stable base
      // prefix and the delivered text, even if later appends replaced the row.
      const baseLength = currentText.length - current.appendText.length;
      const deliveredDeltaLength = deliveredText.length - baseLength;

      if (
        baseLength >= 0 &&
        deliveredDeltaLength > 0 &&
        currentText.endsWith(current.appendText) &&
        currentText.startsWith(deliveredText)
      ) {
        if (deliveredDeltaLength >= current.appendText.length) {
          this.dirtyTextDeltas.delete(entry.id);
          continue;
        }
        this.dirtyTextDeltas.set(entry.id, {
          id: entry.id,
          appendText: current.appendText.slice(deliveredDeltaLength),
        });
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
  toPersistedEntries(): readonly unknown[] {
    if (this.preservedRawEntries.length === 0) return this.entries;

    const preservedByIndex = new Map<number, unknown[]>();
    for (const preserved of this.preservedRawEntries) {
      const index = Math.min(
        Math.max(0, preserved.beforeTypedIndex),
        this.entries.length,
      );
      const bucket = preservedByIndex.get(index);
      if (bucket) {
        bucket.push(preserved.raw);
      } else {
        preservedByIndex.set(index, [preserved.raw]);
      }
    }

    const persisted: unknown[] = [];
    for (let index = 0; index <= this.entries.length; index += 1) {
      const preserved = preservedByIndex.get(index);
      if (preserved) persisted.push(...preserved);
      const entry = this.entries[index];
      if (entry) persisted.push(entry);
    }
    return persisted;
  }
}
