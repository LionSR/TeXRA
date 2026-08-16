import { createLog } from '@logger/logUtils';
import {
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  STREAMING_TEXT_MESSAGE_TYPES,
  isTerminalWorkflowCallProgress,
  type StreamLogEntry,
  type StreamLogTextDelta,
  type WorkflowCallProgress,
} from '@shared/schemas';
import { isObject } from '@utils/core';

const logger = createLog('StreamLog');

export type StreamLogAppendInput = Omit<
  StreamLogEntry,
  'seqNo' | 'settlementSeqNo'
>;
export type StreamLogUpdatePatch = Partial<
  Omit<StreamLogEntry, 'id' | 'seqNo' | 'settlementSeqNo'>
>;

/**
 * One store notification's worth of entry-level change, multicast to every
 * `StreamLogStore.onChange` listener. Entry values are the immutable
 * post-mutation objects (`StreamLog` replaces the entry object on every
 * mutation), so a delta stays valid after later mutations. A dirtied entry
 * supersedes any earlier buffered value for its id.
 */
export interface StreamLogDelta {
  /**
   * Monotonic per-log-instance emission counter. A consumer that detects a
   * gap (`emissionSeq !== lastSeen + 1`) must resync from `getRange(0)`
   * through the same code path as its from-scratch projection.
   */
  readonly emissionSeq: number;
  /** Entries appended since the previous emission, in seqNo order. */
  readonly appended: readonly StreamLogEntry[];
  /**
   * Current values of entries mutated in place since the previous emission
   * (excluding ones also in `appended`, which already carry the latest
   * value), in seqNo order.
   */
  readonly dirtied: readonly StreamLogEntry[];
  /**
   * Streaming-text appends since the previous emission, merged to one chunk
   * per entry id. An `appendText` mutation emits here *instead of* `dirtied`.
   * An entry present in `appended`/`dirtied` already carries its full current
   * text, so no id appears both by value and as a chunk within one delta —
   * and across deltas, an entry-by-value supersedes any chunks a consumer
   * has buffered for its id.
   */
  readonly textChunks: readonly StreamLogTextDelta[];
  /**
   * The stream's log instance was replaced (disk history merged under live
   * appends), renumbering seqNos. Consumers must resync, not fold.
   */
  readonly reset: boolean;
}

/**
 * Consumer-side accumulator that coalesces a burst of {@link StreamLogDelta}
 * emissions into one fold application. Tracks emission continuity: a gap, an
 * explicit reset emission, or a stale-looking sequence marks the buffer as
 * requiring a resync instead of a fold.
 */
export class StreamLogDeltaBuffer {
  /** Emission seq the fold state must be at for `drain()` to be foldable. */
  readonly baseEmissionSeq: number;
  private appended: StreamLogEntry[] = [];
  private readonly appendedIndexById = new Map<string, number>();
  private readonly dirtiedById = new Map<string, StreamLogEntry>();
  /** Buffered streaming-text chunks per id, in arrival order. Cleared for an
   *  id when a later entry-by-value supersedes them. */
  private readonly textChunksById = new Map<string, string[]>();
  private lastSeq: number;
  private needsResync = false;

  constructor(baseEmissionSeq: number) {
    this.baseEmissionSeq = baseEmissionSeq;
    this.lastSeq = baseEmissionSeq;
  }

  /** Latest emission folded into (or invalidating) this buffer. */
  get emissionSeq(): number {
    return this.lastSeq;
  }

  get resyncRequired(): boolean {
    return this.needsResync;
  }

  push(delta: StreamLogDelta): void {
    if (delta.reset) {
      this.needsResync = true;
      return;
    }
    // A stale emission (at or below the base) is already covered by the
    // resync that established the base; drop it. Skipping while a resync is
    // pending is equally safe: the resync rereads the whole log.
    if (delta.emissionSeq <= this.lastSeq || this.needsResync) {
      this.lastSeq = Math.max(this.lastSeq, delta.emissionSeq);
      return;
    }
    if (delta.emissionSeq !== this.lastSeq + 1) {
      this.needsResync = true;
      this.lastSeq = delta.emissionSeq;
      return;
    }
    this.lastSeq = delta.emissionSeq;
    for (const entry of delta.appended) {
      this.appendedIndexById.set(entry.id, this.appended.length);
      this.appended.push(entry);
    }
    for (const entry of delta.dirtied) {
      // The by-value entry carries its full current text: chunks buffered
      // from earlier emissions are already included, so drop them.
      this.textChunksById.delete(entry.id);
      const appendedIndex = this.appendedIndexById.get(entry.id);
      if (appendedIndex !== undefined) {
        this.appended[appendedIndex] = entry;
      } else {
        this.dirtiedById.set(entry.id, entry);
      }
    }
    for (const chunk of delta.textChunks) {
      const chunks = this.textChunksById.get(chunk.id);
      if (chunks) {
        chunks.push(chunk.appendText);
      } else {
        this.textChunksById.set(chunk.id, [chunk.appendText]);
      }
    }
  }

  /**
   * The coalesced changes, dirtied in seqNo order. Call once, then discard.
   * Apply `appended`/`dirtied` before `textChunks`: buffered chunks for an id
   * always postdate its buffered value (a later value deletes earlier
   * chunks), so chunks append on top of the value.
   */
  drain(): {
    appended: StreamLogEntry[];
    dirtied: StreamLogEntry[];
    textChunks: StreamLogTextDelta[];
  } {
    const dirtied = [...this.dirtiedById.values()].sort(
      (a, b) => a.seqNo - b.seqNo,
    );
    const textChunks = [...this.textChunksById].map(([id, chunks]) => ({
      id,
      appendText: chunks.join(''),
    }));
    const appended = this.appended;
    this.appended = [];
    this.appendedIndexById.clear();
    this.dirtiedById.clear();
    this.textChunksById.clear();
    return { appended, dirtied, textChunks };
  }
}

let nextStreamLogInstanceId = 1;

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
  current: StreamLogEntry,
  acc: StreamingTextAccumulator,
  end: number,
): StreamLogEntry {
  const descriptors = Object.getOwnPropertyDescriptors(current);
  let memo: string | undefined;
  descriptors.text = {
    get: () => (memo ??= materializeText(acc, end)),
    enumerable: true,
    configurable: true,
  };
  return Object.defineProperties({}, descriptors) as StreamLogEntry;
}

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

/**
 * The workflow-call progress carried by a workflow-task row that has not
 * reached a terminal status, or `undefined` for every other entry. Returns the
 * parsed call rather than a boolean so the recovery sweep that rewrites such a
 * row does not parse the same payload a second time.
 */
export function nonterminalWorkflowCall(
  entry: StreamLogEntry,
): WorkflowCallProgress | undefined {
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
  /**
   * Distinguishes log instances for the same stream id, so a delta consumer
   * can detect that its fold state was built from an evicted-and-rehydrated
   * (or disk-merged) instance whose seqNos and emission counter restarted.
   */
  readonly instanceId = nextStreamLogInstanceId++;
  private entries: StreamLogEntry[] = [];
  private readonly preservedRawEntries: StreamLogPreservedRawEntry[] = [];
  private seqCounter = 0;
  private readonly indexById = new Map<string, number>();
  /**
   * Per-entry chunk accumulators for in-flight streaming text. An entry whose
   * id is present here carries a lazy `text` getter over the accumulator;
   * settle/update materializes the join into a plain value and drops the
   * accumulator, so persisted and settled entries are always plain.
   */
  private readonly streamingText = new Map<string, StreamingTextAccumulator>();
  private emissionSeqCounter = 0;
  private pendingAppendedIds: string[] = [];
  private readonly pendingDirtiedIds = new Set<string>();
  /**
   * Streaming-text appends since the last drain, per id in arrival order.
   * Drained into the emission's `textChunks` arm — except for ids the same
   * emission carries by value (`appended`/`dirtied`), whose current text
   * already includes them.
   */
  private readonly pendingTextChunks = new Map<string, string[]>();
  private settlementSeqCounter = 0;
  private runningGroupCount = 0;
  private runningStreamingTextCount = 0;
  private nonterminalWorkflowCallCount = 0;

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
  private countEntry(entry: StreamLogEntry, delta: 1 | -1): void {
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

  /**
   * Latest {@link StreamLogDelta.emissionSeq} drained from this instance. A
   * consumer whose fold state matches `(instanceId, emissionHead)` is current
   * and can fold subsequent deltas instead of rereading the log.
   */
  get emissionHead(): number {
    return this.emissionSeqCounter;
  }

  /**
   * True while mutations since the last drain have not been emitted. In the
   * store-mediated flow every mutation is drained synchronously by the
   * notification it triggers, so pending changes at read time mean the log
   * was mutated directly — a fold consumer must rebuild, not fold.
   */
  get hasUndrainedChanges(): boolean {
    return (
      this.pendingAppendedIds.length > 0 ||
      this.pendingDirtiedIds.size > 0 ||
      this.pendingTextChunks.size > 0
    );
  }

  /**
   * Drain the entries changed since the previous drain into an emission
   * payload, allocating its emission seq. Called by `StreamLogStore` exactly
   * once per notification; the payload is multicast unchanged to every
   * listener, so nothing here is consumer-specific and nothing is acked.
   */
  drainEmission(): Omit<StreamLogDelta, 'reset'> {
    const emissionSeq = ++this.emissionSeqCounter;
    if (
      this.pendingAppendedIds.length === 0 &&
      this.pendingDirtiedIds.size === 0 &&
      this.pendingTextChunks.size === 0
    ) {
      return { emissionSeq, appended: [], dirtied: [], textChunks: [] };
    }
    const appendedIds = new Set(this.pendingAppendedIds);
    const appended = this.resolveEntries(this.pendingAppendedIds);
    const dirtied = this.resolveEntries(
      [...this.pendingDirtiedIds].filter((id) => !appendedIds.has(id)),
    ).sort((a, b) => a.seqNo - b.seqNo);
    // An entry emitted by value resolves to its *current* object, whose text
    // already includes every chunk accumulated in this window — emitting its
    // chunks too would double-apply them, so they are dropped here. This is
    // the precedence rule consumers rely on: value supersedes chunks.
    const textChunks: StreamLogTextDelta[] = [];
    for (const [id, chunks] of this.pendingTextChunks) {
      if (!appendedIds.has(id) && !this.pendingDirtiedIds.has(id)) {
        textChunks.push({ id, appendText: chunks.join('') });
      }
    }
    this.pendingAppendedIds = [];
    this.pendingDirtiedIds.clear();
    this.pendingTextChunks.clear();
    return { emissionSeq, appended, dirtied, textChunks };
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
      seqNo: this.seqCounter + 1,
      ...(settled ? { settlementSeqNo: this.settlementSeqCounter + 1 } : {}),
    } as StreamLogEntry;
    this.seqCounter = fullEntry.seqNo;
    if (settled) this.settlementSeqCounter += 1;
    this.indexById.set(fullEntry.id, this.entries.length);
    this.entries.push(fullEntry);
    this.countEntry(fullEntry, 1);
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
    if (current.settlementSeqNo !== undefined) {
      logger.warn(`Ignoring update to settled transcript entry: ${id}`);
      return undefined;
    }
    const settlementSeqNo = settle
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
    // Spreading `current` reads its (possibly lazy) text getter, so this is
    // where a streaming entry's chunks are joined into a plain value.
    const mergedData =
      current.type === STREAM_LOG_ENTRY_TYPES.GROUP_START &&
      patch.type === STREAM_LOG_ENTRY_TYPES.GROUP_END &&
      patch.data !== undefined
        ? { ...current.data, ...patch.data }
        : patch.data;
    const updated = {
      ...current,
      ...patch,
      ...(mergedData !== undefined ? { data: mergedData } : {}),
      id: current.id,
      seqNo: current.seqNo,
      ...(settlementSeqNo !== undefined ? { settlementSeqNo } : {}),
    } as StreamLogEntry;
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

  appendText(id: string, appendText: string): StreamLogEntry | undefined {
    if (appendText.length === 0) return undefined;

    const index = this.indexById.get(id);
    if (index === undefined) return undefined;

    const current = this.entries[index];
    if (current.type !== STREAM_LOG_ENTRY_TYPES.LOG) return undefined;
    if (current.settlementSeqNo !== undefined) {
      logger.warn(`Ignoring text append to settled transcript entry: ${id}`);
      return undefined;
    }

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

  getRange(fromSeq: number, toSeq: number = this.seqCounter): StreamLogEntry[] {
    const safeFrom = Math.max(0, fromSeq);
    const safeTo = Math.min(this.seqCounter, Math.max(safeFrom, toSeq));
    if (safeFrom >= safeTo) return [];
    return this.entries.slice(safeFrom, safeTo);
  }

  /** The current (immutable, post-mutation) entry object for `id`, if any. */
  getById(id: string): StreamLogEntry | undefined {
    const index = this.indexById.get(id);
    return index === undefined ? undefined : this.entries[index];
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
