// The bounded static-scrollback ring behind `StaticConversationTranscript`:
// what the retained tail contains (session header, finalized entries,
// duplicate-row markers), what it costs in rows and bytes, and how an
// incremental tick advances it. Everything here is plain data over the
// transcript fold — no React, no Ink — so the component file holds only the
// component.

import { randomUUID } from 'node:crypto';

import { createLog } from '@logger/logUtils';
import type { RunPhase } from '@shared/schemas';
import { transcriptText, type TranscriptRow } from '@ui/transcript';
import { getModelLabel } from '@shared/model/modelLabel';
import type { RunLabels } from '@shared/tools/executionsDisplay';
import { createBoundedIdSet } from '@utils/core/boundedIdSet';

import { registerCliStateResetHook, type SessionMeta } from '../state/cliState';
import {
  incrementalStaticTranscriptEntries,
  orderedStaticTranscriptEntries,
  type StaticTranscriptScanCursor,
} from './transcriptEntries';
import {
  transcriptEntryLayout,
  transcriptEntryMarginBottomRows,
} from './transcriptEntryLayout';

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
  readonly rowCount: number;
  readonly byteCount: number;
  readonly scan: StaticTranscriptScanCursor;
  /** The layout width `rowCount`/`byteCount` were measured under. */
  readonly layoutWidth: number | undefined;
  /** The run labels `rowCount`/`byteCount` were measured under. */
  readonly runLabels: RunLabels | undefined;
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
  runLabels?: RunLabels,
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
    runLabels,
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

  constructor(initial: StaticTranscriptTotals = { rows: 0, bytes: 0 }) {
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
  runLabels?: RunLabels,
): StaticTranscriptTotals {
  const totals = new StaticTranscriptTotalsAccumulator();
  let aboveMarginBottomRows = 0;
  for (const item of items) {
    const metrics = staticTranscriptItemMetrics(item, width, runLabels);
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
    readonly runLabels?: RunLabels;
    readonly totals: StaticTranscriptTotals;
    readonly width?: number;
  },
): {
  readonly items: readonly StaticTranscriptItem[];
  readonly totals: StaticTranscriptTotals;
  readonly trimmed: boolean;
} {
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
    staticTranscriptItemMetrics(item, options.width, options.runLabels);
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
    readonly runLabels?: RunLabels;
    readonly width?: number;
  },
): {
  readonly items: readonly StaticTranscriptItem[];
  readonly totals: StaticTranscriptTotals;
  readonly trimmed: boolean;
} {
  if (items.length === 0) {
    return { items, totals: { rows: 0, bytes: 0 }, trimmed: false };
  }
  const budgets = options.budgets ?? DEFAULT_STATIC_TRANSCRIPT_RING_BUDGETS;
  const headerCount = items[0]?.kind === 'header' ? 1 : 0;
  if (items.length <= headerCount) {
    const totals = staticTranscriptItemsTotals(
      items,
      options.width,
      options.runLabels,
    );
    return { items, totals, trimmed: false };
  }

  // Layout each item at most once in the backward walk: the accumulator prices
  // a seam from the neighbour's bottom margin alone, so growing the tail never
  // triggers a second layout pass for an item that is already measured.
  const metricsOf = (item: StaticTranscriptItem): StaticTranscriptItemMetrics =>
    staticTranscriptItemMetrics(item, options.width, options.runLabels);

  const headerItem = headerCount > 0 ? items[0] : undefined;
  const headerMarginBottomRows = itemMarginBottomRows(headerItem);
  const totals = new StaticTranscriptTotalsAccumulator();
  if (headerItem !== undefined) {
    totals.insert(0, metricsOf(headerItem), undefined);
  }

  let start = items.length - 1;
  const newest = items[start];
  if (newest === undefined) {
    return { items, totals: { rows: 0, bytes: 0 }, trimmed: false };
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
    runLabels: options.runLabels,
    totals: totals.totals,
    width: options.width,
  });
  return {
    items: retained.items,
    totals: retained.totals,
    trimmed: candidateItems.length < items.length || retained.trimmed,
  };
}

/** The run-label map is a `computed()` signal that can return a fresh
 *  `Map` for unrelated child-roster churn (elapsed timers, active/inactive
 *  flips). Only a content change affects transcript layout, so compare the
 *  label projection semantically instead of by reference. */
function runLabelsEqual(
  left: RunLabels | undefined,
  right: RunLabels | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
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
  byteCount,
  runLabels,
  items,
  maxRows,
  meta,
  rowCount,
  source,
  width,
}: {
  readonly byteCount: number;
  readonly runLabels?: RunLabels;
  readonly items: readonly StaticTranscriptItem[];
  readonly maxRows?: number;
  readonly meta: SessionMeta;
  readonly rowCount: number;
  readonly source: StaticScrollbackSource;
  readonly width?: number;
}): {
  readonly items: readonly StaticTranscriptItem[];
  readonly rowCount: number;
  readonly byteCount: number;
  readonly inserted: boolean;
} {
  if (items[0]?.id === SESSION_HEADER_ID) {
    return { items, rowCount, byteCount, inserted: false };
  }
  if (source.waitingForChildIdentity) {
    return { items, rowCount, byteCount, inserted: false };
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
  const totals = new StaticTranscriptTotalsAccumulator({
    rows: rowCount,
    bytes: byteCount,
  });
  // The header goes in at the very top, so nothing sits above it.
  totals.insert(
    0,
    staticTranscriptItemMetrics(header, width, runLabels),
    firstItem === undefined
      ? undefined
      : staticTranscriptItemMetrics(firstItem, width, runLabels),
  );
  const fitsBudget = maxRows === undefined || totals.rows <= maxRows;
  if (!fitsBudget) {
    return { items, rowCount, byteCount, inserted: false };
  }

  return {
    items: [header, ...items],
    rowCount: totals.rows,
    byteCount: totals.bytes,
    inserted: true,
  };
}

interface BuildStaticTranscriptItemsOptions {
  readonly source: StaticScrollbackSource;
  readonly runLabels?: RunLabels;
  readonly meta: SessionMeta;
  readonly maxRows?: number;
  readonly width?: number;
  readonly ringBudgets?: StaticTranscriptRingBudgets;
}

interface StaticTranscriptBuildResult {
  readonly items: readonly StaticTranscriptItem[];
  readonly rowCount: number;
  readonly byteCount: number;
  readonly trimmed: boolean;
}

const log = createLog('StaticConversationTranscript');
const DUPLICATE_ROW_LOG_CAP = 1000;
/** Row ids already logged as duplicates, so a persistently-colliding id is
 *  logged once instead of once per rebuild. `upsertRow` (sessionFold) and
 *  the local-notice counter (`transcript.ts`) both guarantee unique ids; a
 *  collision here means one of those invariants broke upstream. This gates
 *  only the log call — the inline marker is re-derived on every pass that
 *  still finds the collision (see {@link duplicateRowWarningItems}), so a
 *  later repaint (which replaces all of `<Static>`'s printed output from
 *  the current `items`) never silently drops a marker it already showed. */
const duplicateRowIdsLogged = createBoundedIdSet(DUPLICATE_ROW_LOG_CAP);
// `/clear` resets `localEntrySeq` (`transcript.ts`) back to 0 without
// terminating the TUI, so a local-notice id like `local:0:cli-local` is
// reusable across the reset. Without this hook, a genuinely new collision
// after `/clear` that happens to reuse an already-logged id would be
// mistaken for the old one and suppressed.
registerCliStateResetHook(() => duplicateRowIdsLogged.clear());

/**
 * A fresh, unguessable per-process token, not a fixed string: entry ids are
 * wire content (`z.string().min(1)`, no format constraint), so a marker id
 * built only from a literal prefix and a counter is a string an upstream
 * producer could — in principle, however unlikely — happen to reproduce.
 * Nothing outside this module ever sees or influences `randomUUID()`'s
 * output, so no entry id can be engineered (accidentally or otherwise) to
 * collide with `${DUPLICATE_ROW_WARNING_NAMESPACE}:`.
 */
const DUPLICATE_ROW_WARNING_NAMESPACE = `duplicate-row-warning:${randomUUID()}`;
let duplicateRowWarningSeq = 0;

function nextDuplicateRowWarningId(entryId: string): string {
  return `${DUPLICATE_ROW_WARNING_NAMESPACE}:${duplicateRowWarningSeq++}:${entryId}`;
}

/** The source row id a marker's own item id represents, or `undefined` for
 *  anything that isn't one of this module's markers (namespaced above). */
function duplicateRowWarningSourceId(itemId: string): string | undefined {
  const prefix = `${DUPLICATE_ROW_WARNING_NAMESPACE}:`;
  if (!itemId.startsWith(prefix)) return undefined;
  const rest = itemId.slice(prefix.length);
  const counterEnd = rest.indexOf(':');
  return counterEnd === -1 ? undefined : rest.slice(counterEnd + 1);
}

interface PendingDuplicateRow {
  readonly entry: TranscriptRow;
  readonly markerId: string;
}

interface DuplicateRowScan {
  /** The rows that may join the list, in arrival order, repeats dropped. */
  readonly accepted: readonly TranscriptRow[];
  /** One marker per colliding id this pass is the first to see. */
  readonly pending: readonly PendingDuplicateRow[];
}

/**
 * Split `entries` into the rows a list already holding `existing` can take and
 * the duplicate-id rows that get a marker instead. Both the ids already taken
 * and the collisions already marked are read from `existing`, so a collision
 * spread across ticks (one occurrence arrives now, another arrived several
 * ticks ago and already got its marker) never grows a second marker, while a
 * marker that was later trimmed away is free to reappear — the same
 * requirement as the tail placement in {@link duplicateRowWarningItems}. A
 * repeat within one call is likewise marked once.
 *
 * A full rebuild passes an empty list: it starts from nothing but the session
 * header, which is not a row and holds no row id.
 */
function scanDuplicateRowIds(
  entries: readonly TranscriptRow[],
  existing: readonly StaticTranscriptItem[],
): DuplicateRowScan {
  const taken = new Set(existing.map((item) => item.id));
  const alreadyMarked = new Set(
    existing.flatMap((item) => {
      const sourceId = duplicateRowWarningSourceId(item.id);
      return sourceId === undefined ? [] : [sourceId];
    }),
  );
  const markedThisPass = new Set<string>();
  const accepted: TranscriptRow[] = [];
  const pending: PendingDuplicateRow[] = [];
  for (const entry of entries) {
    if (taken.has(entry.id)) {
      if (!markedThisPass.has(entry.id) && !alreadyMarked.has(entry.id)) {
        markedThisPass.add(entry.id);
        pending.push({
          entry,
          markerId: nextDuplicateRowWarningId(entry.id),
        });
      }
      continue;
    }
    taken.add(entry.id);
    accepted.push(entry);
  }
  return { accepted, pending };
}

/**
 * Visible markers for the duplicate-id rows that were dropped, shaped like the
 * local notices `transcript.ts` synthesizes (`origin: 'local'`, host-assigned
 * id). `log.warn` alone is not enough here: while the TUI owns the terminal,
 * `initCliPlatform` installs a no-op log sink (every interactive launch sets
 * `quietLogs: true`), so logging is a best-effort record for non-interactive
 * hosts and this inline row — matching `EntryErrorBoundary`'s convention of
 * surfacing a render-time defect in the transcript itself — is what an
 * interactive user actually sees.
 *
 * Callers append these at the true tail rather than beside the historical
 * duplicate: retention trims from the front, so a marker here is the last
 * thing a long session's ring budget would ever drop, and a diagnostic
 * surfacing "now" for an old collision is at least as legible as one backdated
 * into scrollback that may already be gone. Derived on every pass that still
 * finds the collision (not gated by whether it was logged before), so a later
 * repaint — which replaces all printed output from the current `items` —
 * doesn't drop a marker it already showed.
 */
function duplicateRowWarningItems(
  pending: readonly PendingDuplicateRow[],
): readonly StaticTranscriptItem[] {
  return pending.map(({ entry, markerId }): StaticTranscriptItem => ({
    id: markerId,
    kind: 'entry',
    entry: {
      id: markerId,
      origin: 'local',
      timestamp: Date.now(),
      level: 'error',
      kind: 'error',
      summary: transcriptText(
        `Duplicate transcript row id (kind ${entry.kind}); dropped a repeat. This points at an upsert or local-notice bug upstream.`,
      ),
      details: [],
      detailText: transcriptText(''),
    },
  }));
}

/**
 * Log each pending duplicate once — never more, and only for the ones whose
 * marker row is still present after ring-budget trimming. A marker trimmed
 * away in the same pass it was inserted never reached the reader, so logging
 * it here would suppress every future retry and the collision would go
 * unlogged for the rest of a long session (the bug this whole warning path
 * exists to avoid, just moved one step later). The marker itself already
 * rendered regardless of this gate — see {@link duplicateRowWarningItems}.
 */
function logSurvivingDuplicates(
  pending: readonly PendingDuplicateRow[],
  survivingItems: readonly StaticTranscriptItem[],
  context: string,
): void {
  if (pending.length === 0) return;
  const survivingIds = new Set(survivingItems.map((item) => item.id));
  for (const { entry, markerId } of pending) {
    if (!survivingIds.has(markerId)) continue;
    if (duplicateRowIdsLogged.has(entry.id)) continue;
    duplicateRowIdsLogged.add(entry.id);
    log.warn(
      `Duplicate transcript row id ${entry.id} (kind ${entry.kind}) in ${context}; dropping the repeat. Row ids should be unique — this points at an upsert or local-notice bug upstream.`,
    );
  }
}

export function buildStaticTranscriptItems(
  options: BuildStaticTranscriptItemsOptions,
): StaticTranscriptBuildResult {
  const {
    source,
    runLabels,
    meta,
    maxRows,
    width,
    ringBudgets = DEFAULT_STATIC_TRANSCRIPT_RING_BUDGETS,
  } = options;
  if (source.waitingForChildIdentity) {
    return { items: [], rowCount: 0, byteCount: 0, trimmed: false };
  }
  const header = ensureStaticSessionHeader({
    byteCount: 0,
    runLabels,
    items: [],
    maxRows,
    meta,
    rowCount: 0,
    source,
    width,
  });
  const items: StaticTranscriptItem[] = [...header.items];
  const duplicates = scanDuplicateRowIds(
    orderedStaticTranscriptEntries(
      source.entries ?? [],
      source.settledRows,
      source.status,
    ),
    [],
  );
  for (const entry of duplicates.accepted) {
    items.push({ id: entry.id, kind: 'entry', entry });
  }
  items.push(...duplicateRowWarningItems(duplicates.pending));

  const retained = retainedStaticTranscriptTail(items, {
    budgets: ringBudgets,
    runLabels,
    width,
  });
  logSurvivingDuplicates(
    duplicates.pending,
    retained.items,
    'a static rebuild',
  );
  return {
    items: retained.items,
    rowCount: retained.totals.rows,
    byteCount: retained.totals.bytes,
    trimmed: retained.trimmed,
  };
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
  runLabels,
  eraseRequest,
  maxRows,
  meta,
  ownerKey,
  repaintEpoch,
  ringBudgets = DEFAULT_STATIC_TRANSCRIPT_RING_BUDGETS,
  source,
  width,
}: {
  readonly runLabels?: RunLabels;
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
    runLabels,
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
    rowCount: built.rowCount,
    byteCount: built.byteCount,
    scan,
    layoutWidth: width,
    runLabels,
    repaintEpoch,
    eraseRequest: eraseRequest ?? 0,
  };
}

export function advanceStaticTranscriptState(
  current: StaticTranscriptState,
  {
    runLabels,
    eraseRequest = current.eraseRequest,
    maxRows,
    meta,
    ownerKey,
    ringBudgets = DEFAULT_STATIC_TRANSCRIPT_RING_BUDGETS,
    source,
    width,
  }: {
    readonly runLabels?: RunLabels;
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
      runLabels,
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
    // render inputs are compared: `rowCount`/`byteCount` are deterministic
    // functions of those fields, and a stale `scan` cursor is recovered by
    // `incrementalStaticTranscriptEntries` on the next non-empty advance.
    if (
      rebuilt.ownerKey === current.ownerKey &&
      rebuilt.layoutWidth === current.layoutWidth &&
      runLabelsEqual(rebuilt.runLabels, current.runLabels) &&
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

  // A label-content change (a child's human label arriving after its
  // executions row printed) rewrites rows already in scrollback, so it repaints
  // from a known origin; a bare width change is repainted by Ink's resize path.
  const labelsChanged = !runLabelsEqual(runLabels, current.runLabels);
  const layoutChanged = width !== current.layoutWidth || labelsChanged;
  let nextItems = current.items;
  let nextRowCount = current.rowCount;
  let nextByteCount = current.byteCount;
  let nextRepaintEpoch = current.repaintEpoch;
  let changed = layoutChanged;

  if (layoutChanged) {
    const recomputed = staticTranscriptItemsTotals(nextItems, width, runLabels);
    const trimmed = trimStaticTranscriptItems(nextItems, {
      budgets: ringBudgets,
      runLabels,
      totals: recomputed,
      width,
    });
    nextItems = trimmed.items;
    nextRowCount = trimmed.totals.rows;
    nextByteCount = trimmed.totals.bytes;
    if (trimmed.trimmed || labelsChanged) {
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
    byteCount: nextByteCount,
    runLabels,
    items: nextItems,
    maxRows,
    meta,
    rowCount: nextRowCount,
    source,
    width,
  });
  if (header.inserted) {
    nextItems = header.items;
    nextRowCount = header.rowCount;
    nextByteCount = header.byteCount;
    nextRepaintEpoch += 1;
    changed = true;
  }

  const totals = new StaticTranscriptTotalsAccumulator({
    rows: nextRowCount,
    bytes: nextByteCount,
  });
  let aboveMarginBottomRows = itemMarginBottomRows(nextItems.at(-1));
  const appendItem = (item: StaticTranscriptItem): void => {
    const metrics = staticTranscriptItemMetrics(item, width, runLabels);
    totals.insert(aboveMarginBottomRows, metrics, undefined);
    aboveMarginBottomRows = metrics.marginBottomRows;
    nextItems = [...nextItems, item];
    changed = true;
  };
  const duplicates =
    plan.appended.length > 0
      ? scanDuplicateRowIds(plan.appended, nextItems)
      : { accepted: [], pending: [] };
  for (const entry of duplicates.accepted) {
    appendItem({ id: entry.id, kind: 'entry', entry });
  }
  for (const item of duplicateRowWarningItems(duplicates.pending)) {
    appendItem(item);
  }
  nextRowCount = totals.rows;
  nextByteCount = totals.bytes;

  const trimmed = trimStaticTranscriptItems(nextItems, {
    budgets: ringBudgets,
    runLabels,
    totals: { rows: nextRowCount, bytes: nextByteCount },
    width,
  });
  if (trimmed.trimmed) {
    nextItems = trimmed.items;
    nextRowCount = trimmed.totals.rows;
    nextByteCount = trimmed.totals.bytes;
    nextRepaintEpoch += 1;
    changed = true;
  }
  logSurvivingDuplicates(
    duplicates.pending,
    nextItems,
    'an incremental append',
  );

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
    rowCount: nextRowCount,
    byteCount: nextByteCount,
    scan: cursor,
    layoutWidth: width,
    runLabels,
    repaintEpoch: nextRepaintEpoch,
    eraseRequest,
  };
}
