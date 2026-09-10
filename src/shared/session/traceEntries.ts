// Shared contracts and utilities
import {
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  STREAMING_TEXT_MESSAGE_TYPES,
  isTerminalWorkflowCallProgress,
  type RunLogEntry,
  type RunLogTextDelta,
  type WorkflowCallLiveProgress,
} from '@shared/schemas';
import { clamp, isObject } from '@utils/core';

export type RunLogAppendInput = Omit<RunLogEntry, 'seqNo' | 'settlementSeqNo'>;
export type RunLogUpdatePatch = Partial<
  Omit<RunLogEntry, 'id' | 'seqNo' | 'settlementSeqNo'>
>;

/**
 * One store notification's worth of entry-level change, multicast to every
 * `StreamLogStore.onChange` listener. Entry values are the immutable
 * post-mutation objects (`StreamLog` replaces the entry object on every
 * mutation), so a delta stays valid after later mutations. A dirtied entry
 * supersedes any earlier buffered value for its id.
 */
export interface RunLogDelta {
  /** Entries appended since the previous emission, in seqNo order. */
  readonly appended: readonly RunLogEntry[];
  /**
   * Current values of entries mutated in place since the previous emission
   * (excluding ones also in `appended`, which already carry the latest
   * value), in seqNo order.
   */
  readonly dirtied: readonly RunLogEntry[];
  /**
   * Streaming-text appends since the previous emission, merged to one chunk
   * per entry id. An `appendText` mutation emits here *instead of* `dirtied`.
   * An entry present in `appended`/`dirtied` already carries its full current
   * text, so no id appears both by value and as a chunk within one delta;
   * and across deltas, an entry-by-value supersedes any chunks a consumer
   * has buffered for its id.
   */
  readonly textChunks: readonly RunLogTextDelta[];
  /**
   * The resident log instance was replaced by an event-prefix fold.
   * Consumers must reread entries before applying further deltas.
   */
  readonly reset: boolean;
}

/**
 * Chunked accumulation for one streaming entry's text. Provider chunks are
 * collected in `chunks` and joined lazily, so a hot appendText path costs
 * O(chunk) instead of re-copying the whole entry text per chunk. `joined` is
 * the memoized join so far; `length` is the full text length including the
 * unjoined tail.
 */
interface StreamingTextAccumulator {
  joined: string;
  chunks: string[];
  length: number;
}

function materializeText(acc: StreamingTextAccumulator, end: number): string {
  if (acc.joined.length < end) {
    acc.joined += acc.chunks.join('');
    acc.chunks.length = 0;
  }
  return end === acc.joined.length ? acc.joined : acc.joined.slice(0, end);
}

/**
 * The immutable post-mutation entry object for a text append: every field of
 * `current` is carried over by descriptor (never invoking `current`'s own
 * lazy getter), while `text` becomes a memoized getter that joins the
 * accumulator's chunks up to this entry's point-in-time length on first read.
 * Readers that never touch `.text` (delta buffering, superseded emissions)
 * pay nothing.
 */
function entryWithLazyText(
  current: RunLogEntry,
  acc: StreamingTextAccumulator,
  end: number,
): RunLogEntry {
  const descriptors = Object.getOwnPropertyDescriptors(current);
  let memo: string | undefined;
  descriptors.text = {
    get: () => (memo ??= materializeText(acc, end)),
    enumerable: true,
    configurable: true,
  };
  return Object.defineProperties({}, descriptors) as RunLogEntry;
}

export function isRunningGroupEntry(entry: RunLogEntry): boolean {
  if (entry.type !== STREAM_LOG_ENTRY_TYPES.GROUP_START) return false;
  const data = isObject(entry.data) ? entry.data : {};
  const status = typeof data.status === 'string' ? data.status : 'running';
  return status === 'running';
}

/**
 * True while a thinking/scratchpad/model-response entry is at
 * `data.status: 'running'`, either still streaming or orphaned
 * because its stream never got a `stream.end` (run cancelled, crashed, or
 * the host reloaded mid-stream). Used both for live in-memory tracking
 * (`hasRunningStreamingText`) and, by the same predicate, to identify
 * orphaned entries at load time in `StreamLogStore`'s recovery sweep.
 */
export function isRunningStreamingTextEntry(entry: RunLogEntry): boolean {
  if (entry.type !== STREAM_LOG_ENTRY_TYPES.LOG) return false;
  if (!STREAMING_TEXT_MESSAGE_TYPES.has(entry.messageType ?? '')) return false;
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
  entry: RunLogEntry,
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

export class RunLog {
  private entries: RunLogEntry[] = [];
  private readonly indexById = new Map<string, number>();
  /**
   * Per-entry chunk accumulators for in-flight streaming text. An entry whose
   * id is present here carries a lazy `text` getter over the accumulator;
   * settle/update materializes the join into a plain value and drops the
   * accumulator, so persisted and settled entries are always plain.
   */
  private readonly streamingText = new Map<string, StreamingTextAccumulator>();
  private pendingAppendedIds: string[] = [];
  private readonly pendingDirtiedIds = new Set<string>();
  /**
   * Streaming-text appends since the last drain, per id in arrival order.
   * Drained into the emission's `textChunks` arm, except for ids the same
   * emission carries by value (`appended`/`dirtied`), whose current text
   * already includes them.
   */
  private readonly pendingTextChunks = new Map<string, string[]>();
  private settlementSeqCounter = 0;
  private runningGroupCount = 0;
  private runningStreamingTextCount = 0;
  private nonterminalWorkflowCallCount = 0;

  constructor(entries: readonly RunLogEntry[] = []) {
    this.entries = [...entries];
    // The settlement head is never below the entry count; one pass over the
    // entries raises it to the highest order already allocated on disk while
    // building the id index and the running-state counters.
    this.settlementSeqCounter = this.entries.length;

    for (const [i, entry] of this.entries.entries()) {
      this.indexById.set(entry.id, i);
      this.countEntry(entry, 1);
      const settlementSeqNo = entry.settlementSeqNo ?? 0;
      if (settlementSeqNo > this.settlementSeqCounter) {
        this.settlementSeqCounter = settlementSeqNo;
      }
    }
  }

  /** Fold an entry into (`1`) or out of (`-1`) the running-state counters. */
  private countEntry(entry: RunLogEntry, delta: 1 | -1): void {
    if (isRunningGroupEntry(entry)) {
      this.runningGroupCount += delta;
    }
    if (isRunningStreamingTextEntry(entry)) {
      this.runningStreamingTextCount += delta;
    }
    if (nonterminalWorkflowCall(entry) !== undefined) {
      this.nonterminalWorkflowCallCount += delta;
    }
  }

  /** Entry count, which is also the next seqNo minus one: entries are never removed. */
  get head(): number {
    return this.entries.length;
  }

  /** Latest durable append-only transcript order allocated by this stream. */
  get settlementHead(): number {
    return this.settlementSeqCounter;
  }

  /**
   * Drain the entries changed since the previous notification into a delta.
   * `StreamLogStore` calls this once and passes the result to its listeners.
   */
  drainEmission(): Omit<RunLogDelta, 'reset'> {
    if (
      this.pendingAppendedIds.length === 0 &&
      this.pendingDirtiedIds.size === 0 &&
      this.pendingTextChunks.size === 0
    ) {
      return { appended: [], dirtied: [], textChunks: [] };
    }
    const appendedIds = new Set(this.pendingAppendedIds);
    const appended = this.resolveEntries(this.pendingAppendedIds);
    const dirtied = this.resolveEntries(
      [...this.pendingDirtiedIds].filter((id) => !appendedIds.has(id)),
    ).sort((a, b) => a.seqNo - b.seqNo);
    // An entry emitted by value resolves to its *current* object, whose text
    // already includes every chunk accumulated in this window. Emitting its
    // chunks too would double-apply them, so they are dropped here. This is
    // the precedence rule consumers rely on: value supersedes chunks.
    const textChunks: RunLogTextDelta[] = [];
    for (const [id, chunks] of this.pendingTextChunks) {
      if (!appendedIds.has(id) && !this.pendingDirtiedIds.has(id)) {
        textChunks.push({ id, appendText: chunks.join('') });
      }
    }
    this.pendingAppendedIds = [];
    this.pendingDirtiedIds.clear();
    this.pendingTextChunks.clear();
    return { appended, dirtied, textChunks };
  }

  /** Current entry objects for `ids`; entries are never removed, so every id resolves. */
  private resolveEntries(ids: readonly string[]): RunLogEntry[] {
    const resolved: RunLogEntry[] = [];
    for (const id of ids) {
      const index = this.indexById.get(id);
      if (index !== undefined) resolved.push(this.entries[index]);
    }
    return resolved;
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

  get hasNonterminalWorkflowCall(): boolean {
    return this.nonterminalWorkflowCallCount > 0;
  }

  /** Fold a canonical recorded entry without allocating new entry coordinates. */
  record(entry: RunLogEntry): void {
    const index = this.indexById.get(entry.id);
    if (index === undefined) {
      this.indexById.set(entry.id, this.entries.length);
      this.entries.push(entry);
      this.pendingAppendedIds.push(entry.id);
    } else {
      this.countEntry(this.entries[index], -1);
      this.entries[index] = entry;
      this.streamingText.delete(entry.id);
      this.pendingDirtiedIds.add(entry.id);
    }
    this.countEntry(entry, 1);
    this.settlementSeqCounter = Math.max(
      this.settlementSeqCounter,
      entry.settlementSeqNo ?? 0,
      this.entries.length,
    );
  }

  append(entry: RunLogAppendInput): RunLogEntry {
    return this.appendWithSettlement(entry, false);
  }

  appendSettled(entry: RunLogAppendInput): RunLogEntry {
    return this.appendWithSettlement(entry, true);
  }

  private appendWithSettlement(
    entry: RunLogAppendInput,
    settled: boolean,
  ): RunLogEntry {
    const fullEntry = {
      ...entry,
      seqNo: this.entries.length + 1,
      ...(settled ? { settlementSeqNo: this.settlementSeqCounter + 1 } : {}),
    } as RunLogEntry;
    if (settled) this.settlementSeqCounter += 1;
    this.indexById.set(fullEntry.id, this.entries.length);
    this.entries.push(fullEntry);
    this.countEntry(fullEntry, 1);
    this.pendingAppendedIds.push(fullEntry.id);
    return fullEntry;
  }

  update(id: string, patch: RunLogUpdatePatch): RunLogEntry | undefined {
    return this.updateWithSettlement(id, patch, false);
  }

  settle(id: string, patch: RunLogUpdatePatch): RunLogEntry | undefined {
    return this.updateWithSettlement(id, patch, true);
  }

  private updateWithSettlement(
    id: string,
    patch: RunLogUpdatePatch,
    settle: boolean,
  ): RunLogEntry | undefined {
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
        Object.is(current[key as keyof RunLogUpdatePatch], value),
      )
    ) {
      return undefined;
    }

    // Merge directly without parsing. update() is on the streaming hot path
    // (tool output chunks at ~200/sec) and receives trusted data from
    // AgentTrace. Persisted entries are parsed when loaded from storage.
    // Spreading `current` reads its (possibly lazy) text getter, so this is
    // where a streaming entry's chunks are joined into a plain value.
    const updated = {
      ...current,
      ...patch,
      id: current.id,
      seqNo: current.seqNo,
      ...(settlementSeqNo !== undefined ? { settlementSeqNo } : {}),
    } as RunLogEntry;
    if (settlementSeqNo !== current.settlementSeqNo) {
      this.settlementSeqCounter += 1;
    }

    this.countEntry(current, -1);
    this.countEntry(updated, 1);

    this.entries[index] = updated;
    this.streamingText.delete(id);
    this.pendingDirtiedIds.add(id);
    return updated;
  }

  appendText(id: string, appendText: string): RunLogEntry | undefined {
    if (appendText.length === 0) return undefined;

    const index = this.indexById.get(id);
    if (index === undefined) return undefined;

    const current = this.entries[index];
    if (current.type !== STREAM_LOG_ENTRY_TYPES.LOG) return undefined;

    let acc = this.streamingText.get(id);
    if (!acc) {
      // Reading `current.text` here materializes any lazy value left behind
      // by a log merge; on the ordinary path it is already a plain value.
      const base = current.text ?? '';
      acc = { joined: base, chunks: [], length: base.length };
      this.streamingText.set(id, acc);
    }
    acc.chunks.push(appendText);
    acc.length += appendText.length;

    const updated = entryWithLazyText(current, acc, acc.length);
    this.entries[index] = updated;
    const chunks = this.pendingTextChunks.get(id);
    if (chunks) {
      chunks.push(appendText);
    } else {
      this.pendingTextChunks.set(id, [appendText]);
    }
    return updated;
  }

  getRange(
    fromSeq: number,
    toSeq: number = this.entries.length,
  ): RunLogEntry[] {
    const safeFrom = Math.max(0, fromSeq);
    const safeTo = clamp(toSeq, safeFrom, this.entries.length);
    if (safeFrom >= safeTo) return [];
    return this.entries.slice(safeFrom, safeTo);
  }

  /** The current (immutable, post-mutation) entry object for `id`, if any. */
  getById(id: string): RunLogEntry | undefined {
    const index = this.indexById.get(id);
    return index === undefined ? undefined : this.entries[index];
  }

  toJSON(): RunLogEntry[] {
    return [...this.entries];
  }
}
