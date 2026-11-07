// The bounded static-scrollback ring behind `StaticConversationTranscript`:
// what the retained tail contains (session header and finalized entries),
// what it costs in rows and bytes, and how one tick advances it. The record
// lives in one `SubscriptionRef` per chat; everything here is plain data over
// the transcript — no React, no Ink — so the component file holds only the
// component.

import { Effect, SubscriptionRef } from 'effect';

import { getModelLabel } from '@texra-ai/harness/schemas';
import type { ProcessRuntime } from '@texra-ai/harness/host';
import type { TranscriptRow } from '@cli/chat/tui/state/sessionView';

import { printableSettledRows } from './transcriptEntries';
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

/** What the terminal's scrollback shows, and where it was printed from. */
interface Scrollback {
  /** The known origin the printed items start from. A new origin clears the
   *  terminal and reprints `items` (the `<Static>` key); everything printed
   *  under one origin is append-only. */
  readonly origin: number;
  /** The scrollback owner the items belong to; undefined before the first
   *  advance and after a restart, which then rebuilds from the source. */
  readonly ownerKey: string | undefined;
  readonly items: readonly StaticTranscriptItem[];
  /** Cumulative row/byte estimates for `items`, maintained incrementally. */
  readonly totals: StaticTranscriptTotals;
  /** The layout width `totals` were measured under. */
  readonly layoutWidth: number | undefined;
  /** How many leading source rows are printed or passed over, and the last
   *  of them: a source whose row there differs is not an extension of what
   *  was printed, so the next advance prints from a new origin. */
  readonly printedThrough: number;
  readonly lastRow: TranscriptRow | undefined;
}

interface StaticTranscriptRingBudgets {
  readonly rowHighWater: number;
  readonly rowLowWater: number;
  readonly byteHighWater: number;
  readonly byteLowWater: number;
}

/** Bounded tail at native-terminal-scrollback scale. The high/low split is
 *  hysteresis: a burst can overflow the high-water mark, then trim once down
 *  to the low-water mark instead of trimming on every subsequent append. */
const STATIC_TRANSCRIPT_RING_BUDGETS: StaticTranscriptRingBudgets =
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

/** The header facts of a child run scrollback, read from the session view. */
export interface ChildHeader {
  readonly label: string;
  readonly modelLabel: string | null;
  readonly childKind: 'script' | 'subagent';
  readonly parentLabel: string;
}

/**
 * What the scrollback paints: the run's rows joined with this
 * TUI's notices, its settled prefix, and the facts the session header names.
 */
export interface StaticScrollbackSource {
  readonly entries: readonly TranscriptRow[] | undefined;
  readonly settledRows: number;
  /** Whether the run is working: a user prompt still waiting for its live
   *  continuation stays out of the scrollback while it is. */
  readonly working: boolean;
  /** A child agent whose model the session view has not applied yet: the header
   *  waits. Only an agent identity carries a model (the session view's `run.config`
   *  rule), so a process or workflow child paints at once. */
  readonly waitingForChildIdentity: boolean;
  /** The child header; undefined paints the session (root) header. */
  readonly child: ChildHeader | undefined;
}

function sessionHeaderIdentityLine(
  meta: SessionMeta,
  child?: ChildHeader,
): string {
  if (child) {
    const model = child.modelLabel ?? getModelLabel(meta.model || '-');
    return `${child.childKind}: ${child.label} · parent: ${child.parentLabel} · model: ${model}`;
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
function trimStaticTranscriptItems(
  items: readonly StaticTranscriptItem[],
  options: {
    readonly totals: StaticTranscriptTotals;
    readonly width?: number;
  },
): RingTail {
  const budgets = STATIC_TRANSCRIPT_RING_BUDGETS;
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
    readonly width?: number;
  },
): RingTail {
  if (items.length === 0) {
    return { items, totals: EMPTY_TOTALS, trimmed: false };
  }
  const budgets = STATIC_TRANSCRIPT_RING_BUDGETS;
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
    totals: totals.totals,
    width: options.width,
  });
  return {
    items: retained.items,
    totals: retained.totals,
    trimmed: candidateItems.length < items.length || retained.trimmed,
  };
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

const EMPTY_SCROLLBACK: Scrollback = Object.freeze({
  origin: 0,
  ownerKey: undefined,
  items: Object.freeze([]),
  totals: EMPTY_TOTALS,
  layoutWidth: undefined,
  printedThrough: 0,
  lastRow: undefined,
});

/** Print the scrollback again from a new origin (`/clear` erased the
 *  terminal, a terminal resume lost it): the next advance rebuilds the
 *  retained tail from the source, and the new origin repaints it. */
function restartScrollback(
  ref: SubscriptionRef.SubscriptionRef<Scrollback>,
): Effect.Effect<void> {
  return SubscriptionRef.update(ref, (current) => ({
    ...EMPTY_SCROLLBACK,
    origin: current.origin + 1,
  }));
}

/** The chat's scrollback record, and the repaint that clears the terminal and
 *  reprints it from a new origin (replace semantics: the remounted
 *  `<Static>`'s output becomes Ink's whole static output). */
export interface ChatScrollback {
  readonly ref: SubscriptionRef.SubscriptionRef<Scrollback>;
  readonly repaint: () => void;
  readonly restart: () => void;
  readonly runtime: ProcessRuntime;
}

interface RepaintTarget {
  repaint(options: {
    readonly clearScrollback: boolean;
    readonly preserveStatic: boolean;
  }): void;
}

/** One chat's scrollback over the Ink instance `ink` holds once `render()`
 *  returns it. */
export function chatScrollback(
  runtime: ProcessRuntime,
  ink: { readonly current?: RepaintTarget },
): ChatScrollback {
  const ref = runtime.runSync(SubscriptionRef.make(EMPTY_SCROLLBACK));
  const restart = (): void => runtime.runSync(restartScrollback(ref));
  return {
    ref,
    runtime,
    restart,
    repaint: () => {
      if (ink.current === undefined) {
        // A new origin inside Ink's first render(), before it returns the
        // instance: print from a further origin once it has, so the repaint
        // runs in a commit that can reach the instance.
        queueMicrotask(restart);
        return;
      }
      ink.current.repaint({ clearScrollback: true, preserveStatic: false });
    },
  };
}

interface ScrollbackInput {
  readonly maxRows?: number;
  readonly meta: SessionMeta;
  readonly ownerKey: string;
  readonly source: StaticScrollbackSource;
  readonly width: number;
}

/** The retained tail built from the source's start, under `origin`. */
function buildScrollback(origin: number, input: ScrollbackInput): Scrollback {
  const { maxRows, meta, ownerKey, source, width } = input;
  const built = { origin, ownerKey, layoutWidth: width };
  if (source.waitingForChildIdentity) {
    return {
      ...built,
      items: [],
      totals: EMPTY_TOTALS,
      printedThrough: 0,
      lastRow: undefined,
    };
  }
  const header = ensureStaticSessionHeader({
    items: [],
    maxRows,
    meta,
    source,
    totals: EMPTY_TOTALS,
    width,
  });
  const rows = source.entries ?? [];
  const printable = printableSettledRows(
    rows,
    0,
    source.settledRows,
    source.working,
  );
  const tail = retainedStaticTranscriptTail(
    [
      ...header.items,
      ...printable.rows.map((entry): StaticTranscriptItem => ({
        id: entry.id,
        kind: 'entry',
        entry,
      })),
    ],
    { width },
  );
  return {
    ...built,
    items: tail.items,
    totals: tail.totals,
    printedThrough: printable.through,
    lastRow: rows[printable.through - 1],
  };
}

/**
 * The scrollback after one tick of its source: the settled rows past
 * `printedThrough` appended in the session view's order, the header inserted
 * once its facts arrive, and the tail trimmed to its budget. Anything that is
 * not an append (another owner, a source that no longer extends what was
 * printed, a header above printed rows, a trim) moves to a new origin.
 * Returns `current` when nothing changed.
 */
export function advanceScrollback(
  current: Scrollback,
  input: ScrollbackInput,
): Scrollback {
  const { maxRows, meta, ownerKey, source, width } = input;
  if (current.ownerKey === undefined) {
    return buildScrollback(current.origin, input);
  }
  const rows = source.entries ?? [];
  const extendsPrinted =
    rows.length >= current.printedThrough &&
    rows[current.printedThrough - 1] === current.lastRow;
  if (current.ownerKey !== ownerKey || !extendsPrinted) {
    return buildScrollback(current.origin + 1, input);
  }
  const hasHeader = current.items[0]?.id === SESSION_HEADER_ID;
  if (!hasHeader && source.waitingForChildIdentity) return current;

  let origin = current.origin;
  let items = current.items;
  let totals = current.totals;
  if (width !== current.layoutWidth) {
    // A bare width change is repainted by Ink's resize path.
    const trimmed = trimStaticTranscriptItems(items, {
      totals: staticTranscriptItemsTotals(items, width),
      width,
    });
    items = trimmed.items;
    totals = trimmed.totals;
    if (trimmed.trimmed) origin += 1;
  }

  const header = ensureStaticSessionHeader({
    items,
    maxRows,
    meta,
    source,
    totals,
    width,
  });
  if (header.inserted) {
    items = header.items;
    totals = header.totals;
    origin += 1;
  }

  const printable = printableSettledRows(
    rows,
    current.printedThrough,
    source.settledRows,
    source.working,
  );
  if (printable.rows.length > 0) {
    const accumulator = new StaticTranscriptTotalsAccumulator(totals);
    let aboveMarginBottomRows = itemMarginBottomRows(items.at(-1));
    const appended: StaticTranscriptItem[] = [];
    for (const entry of printable.rows) {
      const item: StaticTranscriptItem = { id: entry.id, kind: 'entry', entry };
      const metrics = staticTranscriptItemMetrics(item, width);
      accumulator.insert(aboveMarginBottomRows, metrics, undefined);
      aboveMarginBottomRows = metrics.marginBottomRows;
      appended.push(item);
    }
    items = [...items, ...appended];
    totals = accumulator.totals;
  }

  const trimmed = trimStaticTranscriptItems(items, { totals, width });
  if (trimmed.trimmed) {
    items = trimmed.items;
    totals = trimmed.totals;
    origin += 1;
  }

  if (
    items === current.items &&
    width === current.layoutWidth &&
    printable.through === current.printedThrough
  ) {
    return current;
  }
  return {
    origin,
    ownerKey,
    items,
    totals,
    layoutWidth: width,
    printedThrough: printable.through,
    lastRow: rows[printable.through - 1],
  };
}
