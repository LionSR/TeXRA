// Shared contracts and utilities
import {
  MESSAGE_TYPES,
  RUN_PHASE,
  STREAM_LOG_ENTRY_TYPES,
  STREAMING_TEXT_MESSAGE_TYPES,
  isTerminalWorkflowCallProgress,
  type StreamLogEntry,
  type WorkflowCallLiveProgress,
} from '@shared/schemas';
import { isObject } from '@utils/core';

export type StreamLogAppendInput = Omit<
  StreamLogEntry,
  'seqNo' | 'settlementSeqNo'
>;
export type StreamLogUpdatePatch = Partial<
  Omit<StreamLogEntry, 'id' | 'seqNo' | 'settlementSeqNo'>
>;

export function isRunningGroupEntry(entry: StreamLogEntry): boolean {
  return (
    entry.type === STREAM_LOG_ENTRY_TYPES.GROUP_START &&
    entry.data.status === RUN_PHASE.RUNNING
  );
}

/**
 * True while a thinking/scratchpad/model-response entry is at
 * `data.status: 'running'`, either still streaming or orphaned
 * because its stream never got a `stream.end` (run cancelled, crashed, or
 * the host reloaded mid-stream). Its consumers are `SessionHandle`'s
 * host-exit settlement and its status sweep.
 */
export function isRunningStreamingTextEntry(entry: StreamLogEntry): boolean {
  if (entry.type !== STREAM_LOG_ENTRY_TYPES.LOG) return false;
  if (!STREAMING_TEXT_MESSAGE_TYPES.has(entry.messageType)) return false;
  const data = isObject(entry.data) ? entry.data : {};
  return data.status === 'running';
}

/**
 * The workflow-call progress carried by a workflow-task row that has not
 * reached a terminal status, or `undefined` for every other entry. Returns the
 * call itself rather than a boolean so the recovery sweep that rewrites such a
 * row need not re-derive the payload a second time.
 */
export function nonterminalWorkflowCall(
  entry: StreamLogEntry,
): WorkflowCallLiveProgress | undefined {
  if (
    entry.type !== STREAM_LOG_ENTRY_TYPES.LOG ||
    entry.messageType !== MESSAGE_TYPES.WORKFLOW_TASK
  ) {
    return undefined;
  }
  const call = entry.data;
  if (isTerminalWorkflowCallProgress(call)) {
    return undefined;
  }
  return call;
}

export class StreamLog {
  private entries: StreamLogEntry[] = [];
  private readonly indexById = new Map<string, number>();
  private pendingAppendedIds: string[] = [];
  private readonly pendingDirtiedIds = new Set<string>();
  private settlementSeqCounter = 0;

  /**
   * Drain the entries changed since the previous drain. Entry values are the
   * immutable post-mutation objects (every mutation replaces the entry
   * object), so a drained value stays valid after later mutations.
   * `appended` holds entries appended since the previous drain, in seqNo
   * order; `dirtied` holds the current values of entries mutated in place
   * since then, in seqNo order, excluding ones in `appended`, which already
   * carry the latest value.
   */
  drainEmission(): { appended: StreamLogEntry[]; dirtied: StreamLogEntry[] } {
    if (
      this.pendingAppendedIds.length === 0 &&
      this.pendingDirtiedIds.size === 0
    ) {
      return { appended: [], dirtied: [] };
    }
    const appendedIds = new Set(this.pendingAppendedIds);
    const appended = this.resolveEntries(this.pendingAppendedIds);
    const dirtied = this.resolveEntries(
      [...this.pendingDirtiedIds].filter((id) => !appendedIds.has(id)),
    ).sort((a, b) => a.seqNo - b.seqNo);
    this.pendingAppendedIds = [];
    this.pendingDirtiedIds.clear();
    return { appended, dirtied };
  }

  /** Current entry objects for `ids`; entries are never removed, so every id resolves. */
  private resolveEntries(ids: readonly string[]): StreamLogEntry[] {
    const resolved: StreamLogEntry[] = [];
    for (const id of ids) {
      const index = this.indexById.get(id);
      if (index !== undefined) resolved.push(this.entries[index]);
    }
    return resolved;
  }

  /** Fold a canonical recorded entry without allocating new entry coordinates. */
  record(entry: StreamLogEntry): void {
    const index = this.indexById.get(entry.id);
    if (index === undefined) {
      this.indexById.set(entry.id, this.entries.length);
      this.entries.push(entry);
      this.pendingAppendedIds.push(entry.id);
    } else {
      this.entries[index] = entry;
      this.pendingDirtiedIds.add(entry.id);
    }
    this.settlementSeqCounter = Math.max(
      this.settlementSeqCounter,
      entry.settlementSeqNo ?? 0,
      this.entries.length,
    );
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
    const fullEntry = {
      ...entry,
      seqNo: this.entries.length + 1,
      ...(settled ? { settlementSeqNo: this.settlementSeqCounter + 1 } : {}),
    } as StreamLogEntry;
    if (settled) this.settlementSeqCounter += 1;
    this.indexById.set(fullEntry.id, this.entries.length);
    this.entries.push(fullEntry);
    this.pendingAppendedIds.push(fullEntry.id);
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

    // Merge directly without parsing. update() is on the streaming hot path
    // (tool output chunks at ~200/sec) and receives trusted data from
    // AgentTrace. Persisted entries are parsed when loaded from storage.
    const updated = {
      ...current,
      ...patch,
      id: current.id,
      seqNo: current.seqNo,
      ...(settlementSeqNo !== undefined ? { settlementSeqNo } : {}),
    } as StreamLogEntry;
    if (settlementSeqNo !== current.settlementSeqNo) {
      this.settlementSeqCounter += 1;
    }

    this.entries[index] = updated;
    this.pendingDirtiedIds.add(id);
    return updated;
  }

  toJSON(): StreamLogEntry[] {
    return [...this.entries];
  }
}
