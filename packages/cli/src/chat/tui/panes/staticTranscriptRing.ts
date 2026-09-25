// The bounded static-scrollback ring behind `StaticConversationTranscript`:
// what the retained tail contains (session header and finalized entries),
// what it costs in rows and bytes, and how an incremental tick advances it.
// Everything here is plain data over the transcript fold — no React, no Ink —
// so the component file holds only the component.

import type { RunPhase } from '@shared/schemas';
import { getModelLabel } from '@shared/model/modelLabel';
import type { TranscriptRow } from '@ui/transcript';

import {
  incrementalStaticTranscriptEntries,
  orderedStaticTranscriptEntries,
  type StaticTranscriptScanCursor,
} from './transcriptEntries';
import {
  transcriptEntryLayout,
  transcriptEntryMarginBottomRows,
} from './transcriptEntryLayout';
import type { SessionMeta } from '../state/cliState';

export type StaticTranscriptItem =
  | {
      readonly id: string;
      readonly kind: 'header';
      readonly compact: boolean;
      readonly identityLine: string;
      readonly meta: SessionMeta;
    }
  | {
      readonly id: string;
      readonly kind: 'entry';
      readonly entry: TranscriptRow;
    };

export interface StaticTranscriptState {
  readonly ownerKey: string;
  readonly items: readonly StaticTranscriptItem[];
  /** Cumulative row/byte estimates for `items`, maintained incrementally. */
  readonly totals: StaticTranscriptTotals;
  readonly scan: StaticTranscriptScanCursor;
  /** The layout width `totals` were measured under. */
  readonly layoutWidth: number | undefined;
  /** Incremented whenever items change non-append-only (trim, header insert,
   *  hard reset, fold rebuild) so the `<Static>` identity remounts and
   *  `onRenderKeyChange` repaints the bounded tail with replace semantics. */
  readonly repaintEpoch: number;
  /** The last `staticTranscriptEraseEpoch` the state was rebuilt for. An
   *  out-of-band terminal erase (`/clear`) forces a rebuild and repaint even
   *  when the items themselves are unchanged. */
  readonly eraseRequest: number;
}

export interface StaticTranscriptRingBudgets {
  readonly rowHighWater: number;
  readonly rowLowWater: number;
  readonly byteHighWater: number;
  readonly byteLowWater: number;
}

/** Bounded tail at native-terminal-scrollback scale. The high/low split is
 *  hysteresis: a burst can overflow the high-water mark, then trim once down
 *  to the low-water mark instead of trimming on every subsequent append. */
export const DEFAULT_STATIC_TRANSCRIPT_RING_BUDGETS: StaticTranscriptRingBudgets =
  Object.freeze({
    rowHighWater: 2_000,
    rowLowWater: 1_500,
    byteHighWater: 1024 * 1024,
    byteLowWater: 768 * 1024,
  });

interface StaticTranscriptTotals {
  readonly rows: number;
  readonly bytes: number;
}

const EMPTY_TOTALS: StaticTranscriptTotals = Object.freeze({
  rows: 0,
  bytes: 0,
});

/** A retained ring tail with its totals, and whether building it dropped
 *  anything. */
interface RingTail {
  readonly items: readonly StaticTranscriptItem[];
  readonly totals: StaticTranscriptTotals;
  readonly trimmed: boolean;
}

/** The header facts of a child run scrollback, read from the fold. */
export interface ChildHeader {
  readonly label: string;
  readonly modelLabel: string | null;
  readonly childKind: 'workflow script' | 'subagent';
  /** The ancestor's open phase or loop position, when it has one. */
  readonly positionText: string | undefined;
  readonly parentLabel: string;
}

/**
 * What the scrollback paints: the run's folded rows joined with this
 * TUI's notices, its settled prefix, and the facts the session header names.
 */
export interface StaticScrollbackSource {
  readonly entries: readonly TranscriptRow[] | undefined;
  readonly settledRows: number;
  readonly status: RunPhase | undefined;
  /** A child agent whose model the fold has not folded yet: the header
   *  waits. Only an agent identity carries a model (the fold's `run.config`
   *  rule), so a process or workflow child paints at once. */
  readonly waitingForChildIdentity: boolean;
  /** The child header; undefined paints the session (root) header. */
  readonly child: ChildHeader | undefined;
  /** No scrollback stream and nothing local: `/clear` emptied the screen. */
  readonly hardReset: boolean;
}

export function sessionHeaderIdentityLine(
  meta: SessionMeta,
  child?: ChildHeader,
): string {
  if (child) {
    const model = child.modelLabel ?? getModelLabel(meta.model || '-');
    return child.positionText
      ? `${child.childKind}: ${child.label} · ${child.positionText} · parent: ${child.parentLabel} · model: ${model}`
      : `${child.childKind}: ${child.label} · parent: ${child.parentLabel} · model: ${model}`;
  }
  const model = getModelLabel(meta.model || '-');
  const agent = meta.agent || 'chat';
  if (meta.teamName) {
    return `team: ${meta.teamName} · root: ${agent} · model: ${model}`;
  }
  return `agent: ${agent} · model: ${model}`;
}

// Dedupe `<Static>` rows by the entry's own id (a random id from the
// stream log, or a unique `local:…` id for synthetic rows) rather than
// pairing it with the stream id. `moveLocalTranscriptToRun` re-homes
// pre-agent local rows onto the real stream keeping their id; a
// stream-scoped key would treat the moved rows as new and print them
// twice.
const SESSION_HEADER_ID = 'session-header';
const FULL_SESSION_HEADER_ROWS = 4;
const COMPACT_SESSION_HEADER_ROWS = 1;

interface StaticTranscriptItemMetrics {
  /** Rows the item's own lines occupy, before any separator. */
  readonly contentRows: number;
  /** The separator the item asks for above itself, before collapse. */
  readonly declaredTopRows: number;
  /** The separator the item declares below itself. It never collapses — only
   *  the *next* item's top margin collapses against it — so it belongs to the
   *  item, while a top margin belongs to the seam above it. */
  readonly marginBottomRows: number;
  readonly bytes: number;
}

/** Estimated UTF-8 byte footprint plus uncollapsed row geometry for one static
 *  item. Assistant rows include the ANSI Markdown wrappers `<Static>` will
 *  render; the other roles sum plain layout lines without those wrappers, so
 *  the byte figure is an estimate rather than an upper bound. The header's
 *  fixed `+64` is a floor for its chrome, not a bound. Entry metrics come from
 *  the same `scrollback-budget` layout the row budget uses, so the ring never
 *  pays for a second full layout pass. */
function staticTranscriptItemMetrics(
  item: StaticTranscriptItem,
  width?: number,
): StaticTranscriptItemMetrics {
  if (item.kind === 'header') {
    return {
      contentRows: item.compact
        ? COMPACT_SESSION_HEADER_ROWS
        : FULL_SESSION_HEADER_ROWS,
      declaredTopRows: 0,
      marginBottomRows: 0,
      bytes:
        Buffer.byteLength(item.identityLine, 'utf8') +
        Buffer.byteLength(item.meta.version, 'utf8') +
        Buffer.byteLength(item.meta.agent, 'utf8') +
        Buffer.byteLength(item.meta.cwd, 'utf8') +
        64,
    };
  }

  const layout = transcriptEntryLayout(item.entry, {
    mode: 'scrollback-budget',
    previousEntry: undefined,
    width,
  });
  let bytes = 0;
  for (const line of layout.lines) bytes += Buffer.byteLength(line, 'utf8');
  return {
    contentRows: Math.max(1, layout.lines.length),
    declaredTopRows: layout.marginTopRows,
    marginBottomRows: layout.marginBottomRows,
    bytes,
  };
}

/** The separator an item offers to whatever sits below it, which that item's
 *  top margin collapses against. Reading it needs no layout pass, so pricing
 *  the seam under an item never lays that item out again. A header offers
 *  none. */
function itemMarginBottomRows(item: StaticTranscriptItem | undefined): number {
  return item?.kind === 'entry'
    ? transcriptEntryMarginBottomRows(item.entry)
    : 0;
}

/** Rows the boundary between two neighbours costs: the lower item's declared
 *  top separator, collapsed against the separator the upper item offers.
 *  Nothing below means no boundary, and the top of the list collapses against
 *  nothing (`aboveMarginBottomRows` of 0). */
function seamRows(
  aboveMarginBottomRows: number,
  below: StaticTranscriptItemMetrics | undefined,
): number {
  if (below === undefined) return 0;
  return Math.max(0, below.declaredTopRows - aboveMarginBottomRows);
}

/**
 * Running row/byte totals for a static ring. Margin collapse makes the row
 * cost of a list non-additive in its items — the separator between two
 * neighbours is priced once, at the seam between them — so admitting or
 * dropping an item re-prices the seam it closed as well as the two it opened.
 * Every incremental site (rebuild totals, the low-water trim, the backward
 * retain walk, the header insert, the per-tick append) keeps its totals through
 * this one accumulator instead of rederiving that bookkeeping.
 *
 * Operations take pre-measured metrics rather than items, so a caller that has
 * already laid an item out never pays for a second layout pass.
 */
class StaticTranscriptTotalsAccumulator {
  private rowTotal: number;
  private byteTotal: number;

  constructor(initial: StaticTranscriptTotals = EMPTY_TOTALS) {
    this.rowTotal = initial.rows;
    this.byteTotal = initial.bytes;
  }

  get rows(): number {
    return this.rowTotal;
  }

  get bytes(): number {
    return this.byteTotal;
  }

  get totals(): StaticTranscriptTotals {
    return { rows: this.rowTotal, bytes: this.byteTotal };
  }

  /**
   * Account for `item` entering the list, where `aboveMarginBottomRows` is the
   * separator offered by whatever now sits above it (0 at the top of the list)
   * and `below` is the item it now sits on top of (`undefined` for an append
   * at the tail).
   */
  insert(
    aboveMarginBottomRows: number,
    item: StaticTranscriptItemMetrics,
    below: StaticTranscriptItemMetrics | undefined,
  ): void {
    this.rowTotal += this.rowDelta(aboveMarginBottomRows, item, below);
    this.byteTotal += item.bytes;
  }

  /** Account for `item` leaving the list, described by the neighbourhood it
   *  had while it was in it: the seam its two neighbours now share is
   *  re-priced against each other. */
  remove(
    aboveMarginBottomRows: number,
    item: StaticTranscriptItemMetrics,
    below: StaticTranscriptItemMetrics | undefined,
  ): void {
    this.rowTotal -= this.rowDelta(aboveMarginBottomRows, item, below);
    this.byteTotal -= item.bytes;
  }

  private rowDelta(
    aboveMarginBottomRows: number,
    item: StaticTranscriptItemMetrics,
    below: StaticTranscriptItemMetrics | undefined,
  ): number {
    // The item's own lines plus the separator it declares below itself, then
    // the two seams it opens less the one it closes. A top separator is priced
    // at the boundary rather than on the item that declared it, because that is
    // where collapse decides what it actually costs.
    return (
      item.contentRows +
      item.marginBottomRows +
      seamRows(aboveMarginBottomRows, item) +
      seamRows(item.marginBottomRows, below) -
      seamRows(aboveMarginBottomRows, below)
    );
  }
}

function staticTranscriptItemsTotals(
  items: readonly StaticTranscriptItem[],
  width?: number,
): StaticTranscriptTotals {
  const totals = new StaticTranscriptTotalsAccumulator();
  let aboveMarginBottomRows = 0;
  for (const item of items) {
    const metrics = staticTranscriptItemMetrics(item, width);
    totals.insert(aboveMarginBottomRows, metrics, undefined);
    aboveMarginBottomRows = metrics.marginBottomRows;
  }
  return totals.totals;
}

/**
 * Trim the oldest non-header items until the retained tail is at or below
 * both low-water marks. A single oversized newest entry is kept even when it
 * still exceeds a low-water mark; the header is never trimmed.
 */
export function trimStaticTranscriptItems(
  items: readonly StaticTranscriptItem[],
  options: {
    readonly budgets?: StaticTranscriptRingBudgets;
    readonly totals: StaticTranscriptTotals;
    readonly width?: number;
  },
): RingTail {
  const budgets = options.budgets ?? DEFAULT_STATIC_TRANSCRIPT_RING_BUDGETS;
  if (
    options.totals.rows <= budgets.rowHighWater &&
    options.totals.bytes <= budgets.byteHighWater
  ) {
    return { items, totals: options.totals, trimmed: false };
  }

  const nextItems = [...items];
  const totals = new StaticTranscriptTotalsAccumulator(options.totals);
  const headerCount = nextItems[0]?.kind === 'header' ? 1 : 0;
  const metricsOf = (item: StaticTranscriptItem): StaticTranscriptItemMetrics =>
    staticTranscriptItemMetrics(item, options.width);
  // Only the oldest non-header item is ever dropped, so the item above the
  // trim point stays the header (or nothing) for every pass.
  const aboveMarginBottomRows = itemMarginBottomRows(
    headerCount > 0 ? nextItems[0] : undefined,
  );
  let removedAny = false;
  while (
    nextItems.length > headerCount + 1 &&
    (totals.rows > budgets.rowLowWater || totals.bytes > budgets.byteLowWater)
  ) {
    const removedIndex = headerCount;
    const removed = nextItems[removedIndex];
    if (removed === undefined) break;
    const nextRetained = nextItems[removedIndex + 1];
    totals.remove(
      aboveMarginBottomRows,
      metricsOf(removed),
      nextRetained === undefined ? undefined : metricsOf(nextRetained),
    );
    nextItems.splice(removedIndex, 1);
    removedAny = true;
  }

  return removedAny
    ? { items: nextItems, totals: totals.totals, trimmed: true }
    : { items, totals: options.totals, trimmed: false };
}

/**
 * Retained ring tail for a fresh rebuild without laying out the discarded
 * prefix. Walk backward from the newest item until the candidate tail crosses
 * the high-water mark (proving a trim is needed), then hand that bounded tail
 * to {@link trimStaticTranscriptItems} for the low-water pass. When the whole
 * list already fits the high-water mark this returns it unchanged and pays
 * for its full layout, which the caller needs for the retained totals anyway.
 */
function retainedStaticTranscriptTail(
  items: readonly StaticTranscriptItem[],
  options: {
    readonly budgets?: StaticTranscriptRingBudgets;
    readonly width?: number;
  },
): RingTail {
  if (items.length === 0) {
    return { items, totals: EMPTY_TOTALS, trimmed: false };
  }
  const budgets = options.budgets ?? DEFAULT_STATIC_TRANSCRIPT_RING_BUDGETS;
  const headerCount = items[0]?.kind === 'header' ? 1 : 0;
  if (items.length <= headerCount) {
    const totals = staticTranscriptItemsTotals(items, options.width);
    return { items, totals, trimmed: false };
  }

  // Layout each item at most once in the backward walk: the accumulator prices
  // a seam from the neighbour's bottom margin alone, so growing the tail never
  // triggers a second layout pass for an item that is already measured.
  const metricsOf = (item: StaticTranscriptItem): StaticTranscriptItemMetrics =>
    staticTranscriptItemMetrics(item, options.width);

  const headerItem = headerCount > 0 ? items[0] : undefined;
  const headerMarginBottomRows = itemMarginBottomRows(headerItem);
  const totals = new StaticTranscriptTotalsAccumulator();
  if (headerItem !== undefined) {
    totals.insert(0, metricsOf(headerItem), undefined);
  }

  let start = items.length - 1;
  const newest = items[start];
  if (newest === undefined) {
    return { items, totals: EMPTY_TOTALS, trimmed: false };
  }
  let firstMetrics = metricsOf(newest);
  totals.insert(headerMarginBottomRows, firstMetrics, undefined);
  let trimNeeded =
    totals.rows > budgets.rowHighWater || totals.bytes > budgets.byteHighWater;

  while (!trimNeeded && start > headerCount) {
    const candidate = items[start - 1];
    if (candidate === undefined) break;
    const candidateMetrics = metricsOf(candidate);
    totals.insert(headerMarginBottomRows, candidateMetrics, firstMetrics);
    firstMetrics = candidateMetrics;
    start -= 1;
    trimNeeded =
      totals.rows > budgets.rowHighWater ||
      totals.bytes > budgets.byteHighWater;
  }

  if (!trimNeeded) {
    return { items, totals: totals.totals, trimmed: false };
  }

  const candidateItems =
    headerItem !== undefined
      ? [headerItem, ...items.slice(start)]
      : items.slice(start);
  const retained = trimStaticTranscriptItems(candidateItems, {
    budgets,
    totals: totals.totals,
    width: options.width,
  });
  return {
    items: retained.items,
    totals: retained.totals,
    trimmed: candidateItems.length < items.length || retained.trimmed,
  };
}

/** Rendering-relevant item equality: entries compare by reference (they are
 *  immutable log rows), headers by the values `SessionHeaderBlock` draws —
 *  `identityLine` and `compact` directly, plus the `SessionMeta` fields the
 *  block renders (`version`, and `cwd` in the full header only).
 *  The `SessionMeta` fields are compared individually rather than by object
 *  reference because `patchSessionMeta`/`resetCliState` always spread into a
 *  fresh object, even for content-identical patches. A rebuilt state that
 *  matches item-for-item needs no `<Static>` remount. */
function staticTranscriptItemsEquivalent(
  left: readonly StaticTranscriptItem[],
  right: readonly StaticTranscriptItem[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    if (item.kind !== other.kind || item.id !== other.id) return false;
    if (item.kind === 'header' && other.kind === 'header') {
      return (
        item.compact === other.compact &&
        item.identityLine === other.identityLine &&
        item.meta.version === other.meta.version &&
        (item.compact || item.meta.cwd === other.meta.cwd)
      );
    }
    return (
      item.kind === 'entry' &&
      other.kind === 'entry' &&
      item.entry === other.entry
    );
  });
}

function ensureStaticSessionHeader({
  items,
  maxRows,
  meta,
  source,
  totals: current,
  width,
}: {
  readonly items: readonly StaticTranscriptItem[];
  readonly maxRows?: number;
  readonly meta: SessionMeta;
  readonly source: StaticScrollbackSource;
  readonly totals: StaticTranscriptTotals;
  readonly width?: number;
}): {
  readonly items: readonly StaticTranscriptItem[];
  readonly totals: StaticTranscriptTotals;
  readonly inserted: boolean;
} {
  const unchanged = { items, totals: current, inserted: false };
  if (items[0]?.id === SESSION_HEADER_ID || source.waitingForChildIdentity) {
    return unchanged;
  }
  const compact = maxRows !== undefined && maxRows < FULL_SESSION_HEADER_ROWS;
  const header: StaticTranscriptItem = {
    id: SESSION_HEADER_ID,
    kind: 'header',
    compact,
    identityLine: sessionHeaderIdentityLine(meta, source.child),
    meta,
  };
  const firstItem = items[0];
  const totals = new StaticTranscriptTotalsAccumulator(current);
  // The header goes in at the very top, so nothing sits above it.
  totals.insert(
    0,
    staticTranscriptItemMetrics(header, width),
    firstItem === undefined
      ? undefined
      : staticTranscriptItemMetrics(firstItem, width),
  );
  const fitsBudget = maxRows === undefined || totals.rows <= maxRows;
  if (!fitsBudget) return unchanged;

  return { items: [header, ...items], totals: totals.totals, inserted: true };
}

interface BuildStaticTranscriptItemsOptions {
  readonly source: StaticScrollbackSource;
  readonly meta: SessionMeta;
  readonly maxRows?: number;
  readonly width?: number;
  readonly ringBudgets?: StaticTranscriptRingBudgets;
}

export function buildStaticTranscriptItems(
  options: BuildStaticTranscriptItemsOptions,
): RingTail {
  const {
    source,
    meta,
    maxRows,
    width,
    ringBudgets = DEFAULT_STATIC_TRANSCRIPT_RING_BUDGETS,
  } = options;
  if (source.waitingForChildIdentity) {
    return { items: [], totals: EMPTY_TOTALS, trimmed: false };
  }
  const header = ensureStaticSessionHeader({
    items: [],
    maxRows,
    meta,
    source,
    totals: EMPTY_TOTALS,
    width,
  });
  const items: StaticTranscriptItem[] = [...header.items];
  for (const entry of orderedStaticTranscriptEntries(
    source.entries ?? [],
    source.settledRows,
    source.status,
  )) {
    items.push({ id: entry.id, kind: 'entry', entry });
  }

  return retainedStaticTranscriptTail(items, {
    budgets: ringBudgets,
    width,
  });
}

function scanStaticTranscriptFromStart(
  entries: readonly TranscriptRow[] | undefined,
  settledRows: number,
  status: RunPhase | undefined,
): StaticTranscriptScanCursor {
  return incrementalStaticTranscriptEntries(entries, settledRows, status, {
    entriesRef: undefined,
    scannedIndex: 0,
    lastScannedEntry: undefined,
    status: undefined,
    lastAppendedKey: undefined,
  }).cursor;
}

export function buildStaticTranscriptState({
  eraseRequest,
  maxRows,
  meta,
  ownerKey,
  repaintEpoch,
  ringBudgets = DEFAULT_STATIC_TRANSCRIPT_RING_BUDGETS,
  source,
  width,
}: {
  readonly maxRows?: number;
  readonly meta: SessionMeta;
  readonly ownerKey: string;
  readonly repaintEpoch: number;
  readonly ringBudgets?: StaticTranscriptRingBudgets;
  readonly source: StaticScrollbackSource;
  readonly width?: number;
  readonly eraseRequest?: number;
}): StaticTranscriptState {
  const built = buildStaticTranscriptItems({
    source,
    meta,
    maxRows,
    ringBudgets,
    width,
  });
  const scan = source.waitingForChildIdentity
    ? incrementalStaticTranscriptEntries(
        source.entries,
        source.settledRows,
        source.status,
        undefined,
      ).cursor
    : scanStaticTranscriptFromStart(
        source.entries,
        source.settledRows,
        source.status,
      );
  return {
    ownerKey,
    items: built.items,
    totals: built.totals,
    scan,
    layoutWidth: width,
    repaintEpoch,
    eraseRequest: eraseRequest ?? 0,
  };
}

export function advanceStaticTranscriptState(
  current: StaticTranscriptState,
  {
    eraseRequest = current.eraseRequest,
    maxRows,
    meta,
    ownerKey,
    ringBudgets = DEFAULT_STATIC_TRANSCRIPT_RING_BUDGETS,
    source,
    width,
  }: {
    readonly eraseRequest?: number;
    readonly maxRows?: number;
    readonly meta: SessionMeta;
    readonly ownerKey: string;
    readonly ringBudgets?: StaticTranscriptRingBudgets;
    readonly source: StaticScrollbackSource;
    readonly width: number;
  },
): StaticTranscriptState {
  const isHardReset = source.hardReset;
  const entries = source.entries;
  const settledRows = source.settledRows;
  const status = source.status;
  const rebuildState = (repaintEpoch: number): StaticTranscriptState =>
    buildStaticTranscriptState({
      eraseRequest,
      maxRows,
      meta,
      ownerKey,
      repaintEpoch,
      ringBudgets,
      source,
      width,
    });
  if (eraseRequest !== current.eraseRequest) {
    return rebuildState(current.repaintEpoch + 1);
  }

  if (isHardReset) {
    const rebuilt = rebuildState(current.repaintEpoch + 1);
    // A hard reset that rebuilds the current *render inputs* unchanged — the
    // normal startup path, where the initial useState build already ran with
    // no runs — must not bump the repaint epoch. The `<Static>` remount
    // would replay the session header through Ink's append-only static write
    // while the replace-semantics repaint cannot fire yet (the first effect
    // cascade still runs inside Ink's initial render(), before the instance
    // is available to the viewport controller), doubling the header. Only
    // render inputs are compared: `totals` are deterministic
    // functions of those fields, and a stale `scan` cursor is recovered by
    // `incrementalStaticTranscriptEntries` on the next non-empty advance.
    if (
      rebuilt.ownerKey === current.ownerKey &&
      rebuilt.layoutWidth === current.layoutWidth &&
      staticTranscriptItemsEquivalent(rebuilt.items, current.items)
    ) {
      return current;
    }
    return rebuilt;
  }

  if (current.ownerKey !== ownerKey) {
    return rebuildState(current.repaintEpoch);
  }

  if (
    !current.items.some((item) => item.id === SESSION_HEADER_ID) &&
    source.waitingForChildIdentity
  ) {
    return current;
  }

  // A bare width change is repainted by Ink's resize path.
  const layoutChanged = width !== current.layoutWidth;
  let nextItems = current.items;
  let nextTotals = current.totals;
  let nextRepaintEpoch = current.repaintEpoch;
  let changed = layoutChanged;

  if (layoutChanged) {
    const recomputed = staticTranscriptItemsTotals(nextItems, width);
    const trimmed = trimStaticTranscriptItems(nextItems, {
      budgets: ringBudgets,
      totals: recomputed,
      width,
    });
    nextItems = trimmed.items;
    nextTotals = trimmed.totals;
    if (trimmed.trimmed) {
      nextRepaintEpoch += 1;
    }
  }

  const plan = incrementalStaticTranscriptEntries(
    entries,
    settledRows,
    status,
    current.scan,
  );
  if (plan.rebuild) {
    return rebuildState(current.repaintEpoch + 1);
  }

  const header = ensureStaticSessionHeader({
    items: nextItems,
    maxRows,
    meta,
    source,
    totals: nextTotals,
    width,
  });
  if (header.inserted) {
    nextItems = header.items;
    nextTotals = header.totals;
    nextRepaintEpoch += 1;
    changed = true;
  }

  const totals = new StaticTranscriptTotalsAccumulator(nextTotals);
  let aboveMarginBottomRows = itemMarginBottomRows(nextItems.at(-1));
  for (const entry of plan.appended) {
    const item: StaticTranscriptItem = { id: entry.id, kind: 'entry', entry };
    const metrics = staticTranscriptItemMetrics(item, width);
    totals.insert(aboveMarginBottomRows, metrics, undefined);
    aboveMarginBottomRows = metrics.marginBottomRows;
    nextItems = [...nextItems, item];
    changed = true;
  }
  nextTotals = totals.totals;

  const trimmed = trimStaticTranscriptItems(nextItems, {
    budgets: ringBudgets,
    totals: nextTotals,
    width,
  });
  if (trimmed.trimmed) {
    nextItems = trimmed.items;
    nextTotals = trimmed.totals;
    nextRepaintEpoch += 1;
    changed = true;
  }

  const cursor = plan.cursor;
  const cursorChanged =
    cursor.entriesRef !== current.scan.entriesRef ||
    cursor.scannedIndex !== current.scan.scannedIndex ||
    cursor.lastScannedEntry !== current.scan.lastScannedEntry ||
    cursor.status !== current.scan.status;
  if (!changed && !cursorChanged) return current;

  return {
    ownerKey,
    items: nextItems,
    totals: nextTotals,
    scan: cursor,
    layoutWidth: width,
    repaintEpoch: nextRepaintEpoch,
    eraseRequest,
  };
}
