// Session header plus finalized transcript entries. The header is the first
// static row for the active scrollback owner; finalized entries append after it
// in ordinary terminal scrollback through Ink `<Static>`. On a width change,
// the width-qualified Static identity remounts these same items so patched Ink
// can replace its accumulated static output with the new geometry.

import path from 'node:path';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text } from 'ink';

import { shortCliModelAccessRoute } from '@cli/runtime/modelAccessRoute';
import { COLOR_HINT } from '@cli/tui/ui/colors';
import { getRuntimeModelLabel } from '@model/runtimeModelRegistry';
import type { StreamPhase, StreamTabId } from '@shared/schemas';
import type { ExecutionLabels } from '@shared/tools/executionsDisplay';
import { safeHomedir } from '@utils/system/platformPaths';

import {
  sessionMeta as sessionMetaSignal,
  streams as streamsSignal,
  type ConversationEntry,
  type SessionMeta,
  type StreamSlice,
} from '../state/cliState';
import {
  childStreamEntries as childStreamEntriesSignal,
  parentStream as parentStreamSignal,
  type ChildStreamEntries,
} from '../state/childExecutions';
import { streamViewForId } from '../state/streamViews';
import { useSignal } from '../state/useSignal';
import { EntryErrorBoundary } from './EntryErrorBoundary';
import {
  incrementalStaticTranscriptEntries,
  orderedStaticTranscriptEntries,
  type StaticTranscriptScanCursor,
} from './transcriptEntries';
import { TranscriptEntry } from './TranscriptEntry';
import {
  transcriptColumns,
  transcriptEntryLayout,
  transcriptEntryLayoutRows,
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
      readonly entry: ConversationEntry;
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
  /** The execution labels `rowCount`/`byteCount` were measured under. */
  readonly executionLabels: ExecutionLabels | undefined;
  /** Incremented whenever items change non-append-only (trim, header insert,
   *  hard reset, fold rebuild) so the `<Static>` identity remounts and
   *  `onRenderKeyChange` repaints the bounded tail with replace semantics. */
  readonly repaintEpoch: number;
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

function shortenCwd(cwd: string): string {
  const home = safeHomedir();
  if (!home) return cwd;
  if (cwd === home) return '~';
  const sep = path.sep;
  if (cwd.startsWith(`${home}${sep}`)) {
    return `~${sep}${cwd.slice(home.length + sep.length)}`;
  }
  return cwd;
}

export function sessionHeaderIdentityLine(
  meta: SessionMeta,
  context: {
    readonly childStreamEntries?: ChildStreamEntries;
    readonly parentStream?: ReadonlyMap<StreamTabId, StreamTabId>;
    readonly streamId?: StreamTabId;
    readonly streams?: ReadonlyMap<StreamTabId, StreamSlice>;
  } = {},
): string {
  const parentStream = context.parentStream;
  const parentStreamId =
    context.streamId && parentStream?.get(context.streamId);
  if (context.streamId && parentStreamId && parentStream && context.streams) {
    const slice = context.streams.get(context.streamId);
    const model = getRuntimeModelLabel(slice?.model || meta.model || '—');
    const view = streamViewForId({
      activeStreamId: context.streamId,
      childStreamEntries: context.childStreamEntries ?? new Map(),
      parentStream,
      streamId: context.streamId,
      streams: context.streams,
    });
    const streamKind =
      slice?.identity?.kind === 'multiAgentWorkflow'
        ? 'workflow script'
        : 'subagent';
    return `${streamKind}: ${view.label} · parent: ${view.parentLabel} · model: ${model}`;
  }
  const model = getRuntimeModelLabel(meta.model || '—');
  const agent = meta.agent || 'chat';
  if (meta.teamName) {
    return `team: ${meta.teamName} · root: ${agent} · model: ${model}`;
  }
  return `agent: ${agent} · model: ${model}`;
}

function SessionHeaderBlock({
  compact,
  identityLine,
  meta,
  width,
}: {
  readonly compact: boolean;
  readonly identityLine: string;
  readonly meta: SessionMeta;
  readonly width?: number;
}): React.JSX.Element {
  const columns = transcriptColumns(width);
  if (compact) {
    return (
      <Box paddingX={1}>
        <Text wrap="truncate-end">
          <Text bold color={COLOR_HINT}>
            {'{ T } TeXRA'}
          </Text>{' '}
          <Text dimColor>v{meta.version}</Text>{' '}
          <Text dimColor>{shortCliModelAccessRoute(meta.apiMode)}</Text>{' '}
          <Text>{identityLine}</Text>
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box
        aria-hidden
        width={columns}
        borderStyle="single"
        borderTop
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
        borderColor={COLOR_HINT}
      />
      <Box flexDirection="column" paddingX={1}>
        <Box gap={2}>
          <Text bold color={COLOR_HINT}>
            {'{ T } TeXRA'}
          </Text>
          <Text dimColor>v{meta.version}</Text>
          <Text dimColor>{shortCliModelAccessRoute(meta.apiMode)}</Text>
        </Box>
        <Box>
          <Text wrap="truncate-end">{identityLine}</Text>
        </Box>
        <Text dimColor wrap="truncate-end">
          {shortenCwd(meta.cwd)}
        </Text>
      </Box>
    </Box>
  );
}

// Dedupe `<Static>` rows by the entry's own id (a random id from the
// stream log, or a unique `local:…` id for synthetic rows) rather than
// pairing it with the stream id. `moveLocalTranscriptToStream` re-homes
// pre-agent local rows onto the real stream keeping their id; a
// stream-scoped key would treat the moved rows as new and print them
// twice.
const SESSION_HEADER_ID = 'session-header';
const FULL_SESSION_HEADER_ROWS = 4;
const COMPACT_SESSION_HEADER_ROWS = 1;

/** The transcript entry an item sits directly below, when that neighbor is
 *  itself an entry. A header above carries no margin for the next entry to
 *  collapse against. */
function entryAbove(
  item: StaticTranscriptItem | undefined,
): ConversationEntry | undefined {
  return item?.kind === 'entry' ? item.entry : undefined;
}

interface StaticTranscriptItemMetrics {
  readonly rows: number;
  readonly bytes: number;
  /** Rows without margin collapse against a previous item. */
  readonly contentRows: number;
  readonly declaredTopRows: number;
  readonly marginBottomRows: number;
}

/** Row count plus an estimated UTF-8 byte footprint for one static item.
 *  Assistant rows include the ANSI Markdown wrappers `<Static>` will render;
 *  the other roles sum plain layout lines without those wrappers, so the byte
 *  figure is an estimate rather than an upper bound. The header's fixed `+64`
 *  is a floor for its chrome, not a bound. Entry metrics come from the same
 *  `scrollback-budget` layout the row budget uses, so the ring never pays for
 *  a second full layout pass. */
function staticTranscriptItemBaseMetrics(
  item: StaticTranscriptItem,
  width?: number,
  executionLabels?: ExecutionLabels,
): StaticTranscriptItemMetrics {
  if (item.kind === 'header') {
    const rows = item.compact
      ? COMPACT_SESSION_HEADER_ROWS
      : FULL_SESSION_HEADER_ROWS;
    return {
      rows,
      bytes:
        Buffer.byteLength(item.identityLine, 'utf8') +
        Buffer.byteLength(item.meta.version, 'utf8') +
        Buffer.byteLength(item.meta.apiMode, 'utf8') +
        Buffer.byteLength(item.meta.agent, 'utf8') +
        Buffer.byteLength(item.meta.cwd, 'utf8') +
        64,
      contentRows: rows,
      declaredTopRows: 0,
      marginBottomRows: 0,
    };
  }

  const layout = transcriptEntryLayout(item.entry, {
    executionLabels,
    mode: 'scrollback-budget',
    previousEntry: undefined,
    width,
  });
  let bytes = 0;
  for (const line of layout.lines) bytes += Buffer.byteLength(line, 'utf8');
  return {
    rows: transcriptEntryLayoutRows(layout),
    bytes,
    contentRows: Math.max(1, layout.lines.length),
    declaredTopRows: layout.marginTopRows,
    marginBottomRows: layout.marginBottomRows,
  };
}

function staticTranscriptItemMetricsForPrevious(
  base: StaticTranscriptItemMetrics,
  previousBase: StaticTranscriptItemMetrics | undefined,
): StaticTranscriptItemMetrics {
  const marginTopRows =
    previousBase === undefined
      ? base.declaredTopRows
      : Math.max(0, base.declaredTopRows - previousBase.marginBottomRows);
  return {
    ...base,
    rows: base.contentRows + marginTopRows + base.marginBottomRows,
  };
}

function staticTranscriptPreviousBase(
  previousItem: StaticTranscriptItem | undefined,
): StaticTranscriptItemMetrics | undefined {
  const previousEntry =
    previousItem === undefined ? undefined : entryAbove(previousItem);
  if (previousEntry === undefined) return undefined;
  // Only the previous entry's bottom margin participates in collapse; laying
  // out the whole previous item here would duplicate its layout cost.
  return {
    rows: 0,
    bytes: 0,
    contentRows: 0,
    declaredTopRows: 0,
    marginBottomRows: transcriptEntryMarginBottomRows(previousEntry),
  };
}

function staticTranscriptItemMetrics(
  item: StaticTranscriptItem,
  width?: number,
  executionLabels?: ExecutionLabels,
  previousItem?: StaticTranscriptItem,
): StaticTranscriptItemMetrics {
  const base = staticTranscriptItemBaseMetrics(item, width, executionLabels);
  if (item.kind === 'header') return base;
  return staticTranscriptItemMetricsForPrevious(
    base,
    staticTranscriptPreviousBase(previousItem),
  );
}

function staticTranscriptItemRowCount(
  item: StaticTranscriptItem,
  width?: number,
  executionLabels?: ExecutionLabels,
  previousItem?: StaticTranscriptItem,
): number {
  return staticTranscriptItemMetrics(item, width, executionLabels, previousItem)
    .rows;
}

function staticTranscriptItemsTotals(
  items: readonly StaticTranscriptItem[],
  width?: number,
  executionLabels?: ExecutionLabels,
): StaticTranscriptTotals {
  let rows = 0;
  let bytes = 0;
  let previousItem: StaticTranscriptItem | undefined;
  for (const item of items) {
    const metrics = staticTranscriptItemMetrics(
      item,
      width,
      executionLabels,
      previousItem,
    );
    rows += metrics.rows;
    bytes += metrics.bytes;
    previousItem = item;
  }
  return { rows, bytes };
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
    readonly executionLabels?: ExecutionLabels;
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
  const totals = { ...options.totals };
  const headerCount = nextItems[0]?.kind === 'header' ? 1 : 0;
  let removedAny = false;
  while (
    nextItems.length > headerCount + 1 &&
    (totals.rows > budgets.rowLowWater || totals.bytes > budgets.byteLowWater)
  ) {
    const removedIndex = headerCount;
    const removed = nextItems[removedIndex];
    if (removed === undefined) break;
    const previousItem =
      removedIndex > 0 ? nextItems[removedIndex - 1] : undefined;
    const removedMetrics = staticTranscriptItemMetrics(
      removed,
      options.width,
      options.executionLabels,
      previousItem,
    );
    totals.rows -= removedMetrics.rows;
    totals.bytes -= removedMetrics.bytes;

    const nextRetained = nextItems[removedIndex + 1];
    if (nextRetained !== undefined) {
      const oldNextMetrics = staticTranscriptItemMetrics(
        nextRetained,
        options.width,
        options.executionLabels,
        removed,
      );
      nextItems.splice(removedIndex, 1);
      const newPrevious =
        removedIndex > 0 ? nextItems[removedIndex - 1] : undefined;
      const newNextMetrics = staticTranscriptItemMetrics(
        nextRetained,
        options.width,
        options.executionLabels,
        newPrevious,
      );
      totals.rows += newNextMetrics.rows - oldNextMetrics.rows;
      totals.bytes += newNextMetrics.bytes - oldNextMetrics.bytes;
    } else {
      nextItems.splice(removedIndex, 1);
    }
    removedAny = true;
  }

  return removedAny
    ? { items: nextItems, totals, trimmed: true }
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
    readonly executionLabels?: ExecutionLabels;
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
      options.executionLabels,
    );
    return { items, totals, trimmed: false };
  }

  const headerItem = headerCount > 0 ? items[0] : undefined;
  const headerBase =
    headerItem !== undefined
      ? staticTranscriptItemBaseMetrics(
          headerItem,
          options.width,
          options.executionLabels,
        )
      : undefined;

  // Layout each item at most once in the backward walk. `previousBase` only
  // supplies the previous entry's bottom margin, so row-collapse adjustments
  // never trigger a second layout pass for an item that is already measured.
  const baseFor = (item: StaticTranscriptItem): StaticTranscriptItemMetrics =>
    staticTranscriptItemBaseMetrics(
      item,
      options.width,
      options.executionLabels,
    );

  let start = items.length - 1;
  const newest = items[start];
  let firstBase = newest === undefined ? undefined : baseFor(newest);
  if (firstBase === undefined) {
    return { items, totals: { rows: 0, bytes: 0 }, trimmed: false };
  }
  const firstMetrics = staticTranscriptItemMetricsForPrevious(
    firstBase,
    headerBase,
  );
  let totals = {
    rows: (headerBase?.rows ?? 0) + firstMetrics.rows,
    bytes: (headerBase?.bytes ?? 0) + firstMetrics.bytes,
  };
  let trimNeeded =
    totals.rows > budgets.rowHighWater || totals.bytes > budgets.byteHighWater;

  while (!trimNeeded && start > headerCount) {
    const candidate = items[start - 1];
    if (candidate === undefined) break;
    const candidateBase = baseFor(candidate);
    const oldFirst = items[start];
    if (oldFirst === undefined) break;
    const oldFirstBase = firstBase;
    const oldFirstBefore = staticTranscriptItemMetricsForPrevious(
      oldFirstBase,
      headerBase,
    );
    const candidateMetrics = staticTranscriptItemMetricsForPrevious(
      candidateBase,
      headerBase,
    );
    const oldFirstAfter = staticTranscriptItemMetricsForPrevious(
      oldFirstBase,
      candidateBase,
    );
    totals = {
      rows:
        totals.rows -
        oldFirstBefore.rows +
        candidateMetrics.rows +
        oldFirstAfter.rows,
      bytes: totals.bytes + candidateBase.bytes,
    };
    firstBase = candidateBase;
    start -= 1;
    trimNeeded =
      totals.rows > budgets.rowHighWater ||
      totals.bytes > budgets.byteHighWater;
  }

  if (!trimNeeded) {
    return { items, totals, trimmed: false };
  }

  const candidateItems =
    headerItem !== undefined
      ? [headerItem, ...items.slice(start)]
      : items.slice(start);
  const retained = trimStaticTranscriptItems(candidateItems, {
    budgets,
    executionLabels: options.executionLabels,
    totals,
    width: options.width,
  });
  return {
    items: retained.items,
    totals: retained.totals,
    trimmed: candidateItems.length < items.length || retained.trimmed,
  };
}

/** The execution-label map is a `computed()` signal that can return a fresh
 *  `Map` for unrelated child-roster churn (elapsed timers, active/inactive
 *  flips). Only a content change affects transcript layout, so compare the
 *  label projection semantically instead of by reference. */
function executionLabelsEqual(
  left: ExecutionLabels | undefined,
  right: ExecutionLabels | undefined,
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
 *  block renders (`version`, `apiMode`, `cwd`). The `SessionMeta` fields are
 *  compared individually rather than by object reference because
 *  `patchSessionMeta`/`resetCliState` always spread into a fresh object, even
 *  for content-identical patches. A rebuilt state that matches item-for-item
 *  needs no `<Static>` remount. */
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
        item.meta.apiMode === other.meta.apiMode &&
        item.meta.cwd === other.meta.cwd
      );
    }
    return (
      item.kind === 'entry' &&
      other.kind === 'entry' &&
      item.entry === other.entry
    );
  });
}

function shouldWaitForChildIdentity({
  currentItems,
  parentStream,
  scrollbackStreamId,
  streams,
}: {
  readonly currentItems: readonly StaticTranscriptItem[];
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly scrollbackStreamId: StreamTabId | undefined;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): boolean {
  return (
    !currentItems.some((item) => item.id === SESSION_HEADER_ID) &&
    scrollbackStreamId !== undefined &&
    parentStream.has(scrollbackStreamId) &&
    !streams.get(scrollbackStreamId)?.model
  );
}

function ensureStaticSessionHeader({
  byteCount,
  childStreamEntries,
  executionLabels,
  items,
  maxRows,
  meta,
  parentStream,
  rowCount,
  scrollbackStreamId,
  streams,
  width,
}: {
  readonly byteCount: number;
  readonly childStreamEntries: ChildStreamEntries;
  readonly executionLabels?: ExecutionLabels;
  readonly items: readonly StaticTranscriptItem[];
  readonly maxRows?: number;
  readonly meta: SessionMeta;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly rowCount: number;
  readonly scrollbackStreamId: StreamTabId | undefined;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
  readonly width?: number;
}): {
  readonly items: readonly StaticTranscriptItem[];
  readonly rowCount: number;
  readonly byteCount: number;
  readonly inserted: boolean;
} {
  if (items.some((item) => item.id === SESSION_HEADER_ID)) {
    return { items, rowCount, byteCount, inserted: false };
  }
  if (
    shouldWaitForChildIdentity({
      currentItems: items,
      parentStream,
      scrollbackStreamId,
      streams,
    })
  ) {
    return { items, rowCount, byteCount, inserted: false };
  }

  const compact = maxRows !== undefined && maxRows < FULL_SESSION_HEADER_ROWS;
  const header: StaticTranscriptItem = {
    id: SESSION_HEADER_ID,
    kind: 'header',
    compact,
    identityLine: sessionHeaderIdentityLine(meta, {
      childStreamEntries,
      parentStream,
      streamId: scrollbackStreamId,
      streams,
    }),
    meta,
  };
  const headerMetrics = staticTranscriptItemMetrics(
    header,
    width,
    executionLabels,
  );
  const firstItem = items.find((item) => item.kind !== 'header');
  let nextRowCount: number;
  let nextByteCount: number;
  if (firstItem === undefined) {
    nextRowCount = rowCount + headerMetrics.rows;
    nextByteCount = byteCount + headerMetrics.bytes;
  } else {
    const oldFirstMetrics = staticTranscriptItemMetrics(
      firstItem,
      width,
      executionLabels,
    );
    const newFirstMetrics = staticTranscriptItemMetrics(
      firstItem,
      width,
      executionLabels,
      header,
    );
    nextRowCount =
      rowCount -
      oldFirstMetrics.rows +
      newFirstMetrics.rows +
      headerMetrics.rows;
    nextByteCount =
      byteCount -
      oldFirstMetrics.bytes +
      newFirstMetrics.bytes +
      headerMetrics.bytes;
  }
  const fitsBudget = maxRows === undefined || nextRowCount <= maxRows;
  if (!fitsBudget) {
    return { items, rowCount, byteCount, inserted: false };
  }

  const firstEntryIndex = items.findIndex((item) => item.kind !== 'header');
  const nextItems = [...items];
  nextItems.splice(
    firstEntryIndex < 0 ? nextItems.length : firstEntryIndex,
    0,
    header,
  );
  return {
    items: nextItems,
    rowCount: nextRowCount,
    byteCount: nextByteCount,
    inserted: true,
  };
}

interface BuildStaticTranscriptItemsOptions {
  readonly currentItems: readonly StaticTranscriptItem[];
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
  readonly childStreamEntries?: ChildStreamEntries;
  readonly executionLabels?: ExecutionLabels;
  readonly meta: SessionMeta;
  readonly maxRows?: number;
  readonly parentStream?: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly scrollbackStreamId: StreamTabId | undefined;
  readonly width?: number;
  readonly ringBudgets?: StaticTranscriptRingBudgets;
}

interface StaticTranscriptBuildResult {
  readonly items: readonly StaticTranscriptItem[];
  readonly rowCount: number;
  readonly byteCount: number;
  readonly trimmed: boolean;
}

/** Full rebuild path. This is the from-scratch oracle used on owner switch,
 *  hard reset, and fold rebuild; ordinary ticks use the incremental scan in
 *  {@link incrementalStaticTranscriptEntries}. */
export function buildStaticTranscriptItems(
  options: BuildStaticTranscriptItemsOptions,
): StaticTranscriptBuildResult {
  const {
    currentItems,
    streams,
    childStreamEntries = new Map(),
    executionLabels,
    meta,
    maxRows,
    parentStream = new Map(),
    scrollbackStreamId,
    width,
    ringBudgets = DEFAULT_STATIC_TRANSCRIPT_RING_BUDGETS,
  } = options;
  const seen = new Set(currentItems.map((item) => item.id));
  // Copied lazily: this runs on every stream-sync tick and most ticks append
  // nothing.
  let nextItems: StaticTranscriptItem[] | undefined;
  if (
    shouldWaitForChildIdentity({
      currentItems,
      parentStream,
      scrollbackStreamId,
      streams,
    })
  ) {
    const totals = staticTranscriptItemsTotals(
      currentItems,
      width,
      executionLabels,
    );
    const trimmed = trimStaticTranscriptItems(currentItems, {
      budgets: ringBudgets,
      executionLabels,
      totals,
      width,
    });
    return {
      items: trimmed.items,
      rowCount: trimmed.totals.rows,
      byteCount: trimmed.totals.bytes,
      trimmed: trimmed.trimmed,
    };
  }

  if (!seen.has(SESSION_HEADER_ID)) {
    const header: StaticTranscriptItem = {
      id: SESSION_HEADER_ID,
      kind: 'header',
      compact: maxRows !== undefined && maxRows < FULL_SESSION_HEADER_ROWS,
      identityLine: sessionHeaderIdentityLine(meta, {
        childStreamEntries,
        parentStream,
        streamId: scrollbackStreamId,
        streams,
      }),
      meta,
    };
    // The row budget only applies on compact terminals (maxRows defined), and
    // counting rows wraps every item's full text — O(history) — so it must
    // stay behind the maxRows gate rather than run eagerly per tick.
    const fitsBudget =
      maxRows === undefined ||
      currentItems.reduce(
        (total, item, index) =>
          total +
          staticTranscriptItemRowCount(
            item,
            width,
            executionLabels,
            index === 0 ? header : currentItems[index - 1],
          ),
        staticTranscriptItemRowCount(header, width, executionLabels),
      ) <= maxRows;
    if (fitsBudget) {
      nextItems = [...currentItems];
      const firstEntryIndex = nextItems.findIndex(
        (item) => item.kind !== 'header',
      );
      nextItems.splice(
        firstEntryIndex < 0 ? nextItems.length : firstEntryIndex,
        0,
        header,
      );
      seen.add(SESSION_HEADER_ID);
    }
  }

  // Only the selected scrollback owner feeds `<Static>` output. Root focus owns
  // root history; child focus owns that child's history. Other streams stay
  // available through their own focus.
  const slice = scrollbackStreamId
    ? streams.get(scrollbackStreamId)
    : undefined;
  const entries = slice?.entries ?? [];
  const orderedStaticEntries = orderedStaticTranscriptEntries(
    entries,
    slice?.status,
  );
  const appendItem = (item: StaticTranscriptItem): void => {
    nextItems ??= [...currentItems];
    nextItems.push(item);
    seen.add(item.id);
  };

  for (const entry of orderedStaticEntries) {
    if (!seen.has(entry.id)) {
      appendItem({ id: entry.id, kind: 'entry', entry });
    }
  }

  const items = nextItems ?? currentItems;
  const retained = retainedStaticTranscriptTail(items, {
    budgets: ringBudgets,
    executionLabels,
    width,
  });
  return {
    items: retained.items,
    rowCount: retained.totals.rows,
    byteCount: retained.totals.bytes,
    trimmed: retained.trimmed,
  };
}

function StaticTranscriptItemContent({
  colorEnabled,
  executionLabels,
  item,
  previousItem,
  width,
}: {
  readonly colorEnabled?: boolean;
  readonly executionLabels?: ExecutionLabels;
  readonly item: StaticTranscriptItem;
  readonly previousItem?: StaticTranscriptItem;
  readonly width: number;
}): React.JSX.Element {
  switch (item.kind) {
    case 'header':
      return (
        <EntryErrorBoundary label="session header">
          <SessionHeaderBlock
            compact={item.compact}
            identityLine={item.identityLine}
            meta={item.meta}
            width={width}
          />
        </EntryErrorBoundary>
      );
    case 'entry':
      return (
        <EntryErrorBoundary label={item.entry.role}>
          <TranscriptEntry
            entry={item.entry}
            previousEntry={entryAbove(previousItem)}
            subagentExecutionLabels={executionLabels}
            width={width}
            colorEnabled={colorEnabled}
          />
        </EntryErrorBoundary>
      );
  }
}

function scanStaticTranscriptFromStart(
  entries: readonly ConversationEntry[] | undefined,
  status: StreamPhase | undefined,
): StaticTranscriptScanCursor {
  return incrementalStaticTranscriptEntries(entries, status, {
    entriesRef: undefined,
    scannedIndex: 0,
    lastScannedEntry: undefined,
    status: undefined,
  }).cursor;
}

export function buildStaticTranscriptState({
  childStreamEntries,
  executionLabels,
  maxRows,
  meta,
  ownerKey,
  parentStream,
  repaintEpoch,
  ringBudgets = DEFAULT_STATIC_TRANSCRIPT_RING_BUDGETS,
  scrollbackStreamId,
  streams,
  width,
}: {
  readonly childStreamEntries: ChildStreamEntries;
  readonly executionLabels?: ExecutionLabels;
  readonly maxRows?: number;
  readonly meta: SessionMeta;
  readonly ownerKey: string;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly repaintEpoch: number;
  readonly ringBudgets?: StaticTranscriptRingBudgets;
  readonly scrollbackStreamId: StreamTabId | undefined;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
  readonly width?: number;
}): StaticTranscriptState {
  const built = buildStaticTranscriptItems({
    currentItems: [],
    streams,
    childStreamEntries,
    executionLabels,
    meta,
    maxRows,
    parentStream,
    ringBudgets,
    scrollbackStreamId,
    width,
  });
  const slice = scrollbackStreamId
    ? streams.get(scrollbackStreamId)
    : undefined;
  // While a focused child has no model yet, buildStaticTranscriptItems
  // intentionally holds neither the header nor entries. Keep the scan cursor
  // at zero with the current entries reference so the entries are still
  // pending when the model arrives; scanning them now would mark them
  // consumed and drop them later.
  const waitingForChildIdentity = shouldWaitForChildIdentity({
    currentItems: [],
    parentStream,
    scrollbackStreamId,
    streams,
  });
  const scan = waitingForChildIdentity
    ? incrementalStaticTranscriptEntries(
        slice?.entries,
        slice?.status,
        undefined,
      ).cursor
    : scanStaticTranscriptFromStart(slice?.entries, slice?.status);
  return {
    ownerKey,
    items: built.items,
    rowCount: built.rowCount,
    byteCount: built.byteCount,
    scan,
    layoutWidth: width,
    executionLabels,
    repaintEpoch,
  };
}

export function advanceStaticTranscriptState(
  current: StaticTranscriptState,
  {
    childStreamEntries,
    executionLabels,
    maxRows,
    meta,
    ownerKey,
    parentStream,
    ringBudgets = DEFAULT_STATIC_TRANSCRIPT_RING_BUDGETS,
    scrollbackStreamId,
    streams,
    width,
  }: {
    readonly childStreamEntries: ChildStreamEntries;
    readonly executionLabels?: ExecutionLabels;
    readonly maxRows?: number;
    readonly meta: SessionMeta;
    readonly ownerKey: string;
    readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
    readonly ringBudgets?: StaticTranscriptRingBudgets;
    readonly scrollbackStreamId: StreamTabId | undefined;
    readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
    readonly width: number;
  },
): StaticTranscriptState {
  const isHardReset = streams.size === 0 && scrollbackStreamId === undefined;
  const slice = scrollbackStreamId
    ? streams.get(scrollbackStreamId)
    : undefined;
  // Pass `slice?.entries` through unchanged. `incrementalStaticTranscriptEntries`
  // normalizes a missing slice to its frozen empty entries array; a fresh `[]`
  // here would break cursor identity on every dependency tick while the
  // scrollback slice is absent.
  const entries = slice?.entries;
  const status = slice?.status;

  if (isHardReset) {
    const rebuilt = buildStaticTranscriptState({
      childStreamEntries,
      executionLabels,
      maxRows,
      meta,
      ownerKey,
      parentStream,
      repaintEpoch: current.repaintEpoch + 1,
      ringBudgets,
      scrollbackStreamId,
      streams,
      width,
    });
    // A hard reset that rebuilds the current state unchanged — the normal
    // startup path, where the initial useState build already ran with no
    // streams — must not bump the repaint epoch. The `<Static>` remount would
    // replay the session header through Ink's append-only static write while
    // the replace-semantics repaint cannot fire yet (the first effect
    // cascade still runs inside Ink's initial render(), before the instance
    // is available to the viewport controller), doubling the header.
    if (
      rebuilt.ownerKey === current.ownerKey &&
      rebuilt.layoutWidth === current.layoutWidth &&
      executionLabelsEqual(rebuilt.executionLabels, current.executionLabels) &&
      staticTranscriptItemsEquivalent(rebuilt.items, current.items)
    ) {
      return current;
    }
    return rebuilt;
  }

  if (current.ownerKey !== ownerKey) {
    return buildStaticTranscriptState({
      childStreamEntries,
      executionLabels,
      maxRows,
      meta,
      ownerKey,
      parentStream,
      repaintEpoch: current.repaintEpoch,
      ringBudgets,
      scrollbackStreamId,
      streams,
      width,
    });
  }

  if (
    shouldWaitForChildIdentity({
      currentItems: current.items,
      parentStream,
      scrollbackStreamId,
      streams,
    })
  ) {
    return current;
  }

  const layoutChanged =
    width !== current.layoutWidth ||
    !executionLabelsEqual(executionLabels, current.executionLabels);
  let nextItems = current.items;
  let nextRowCount = current.rowCount;
  let nextByteCount = current.byteCount;
  let nextRepaintEpoch = current.repaintEpoch;
  let changed = layoutChanged;

  if (layoutChanged) {
    const recomputed = staticTranscriptItemsTotals(
      nextItems,
      width,
      executionLabels,
    );
    const trimmed = trimStaticTranscriptItems(nextItems, {
      budgets: ringBudgets,
      executionLabels,
      totals: recomputed,
      width,
    });
    nextItems = trimmed.items;
    nextRowCount = trimmed.totals.rows;
    nextByteCount = trimmed.totals.bytes;
    if (trimmed.trimmed) {
      nextRepaintEpoch += 1;
    }
  }

  const plan = incrementalStaticTranscriptEntries(
    entries,
    status,
    current.scan,
  );
  if (plan.rebuild) {
    return buildStaticTranscriptState({
      childStreamEntries,
      executionLabels,
      maxRows,
      meta,
      ownerKey,
      parentStream,
      repaintEpoch: current.repaintEpoch + 1,
      ringBudgets,
      scrollbackStreamId,
      streams,
      width,
    });
  }

  const header = ensureStaticSessionHeader({
    byteCount: nextByteCount,
    childStreamEntries,
    executionLabels,
    items: nextItems,
    maxRows,
    meta,
    parentStream,
    rowCount: nextRowCount,
    scrollbackStreamId,
    streams,
    width,
  });
  if (header.inserted) {
    nextItems = header.items;
    nextRowCount = header.rowCount;
    nextByteCount = header.byteCount;
    nextRepaintEpoch += 1;
    changed = true;
  }

  let previousItem = nextItems.at(-1);
  if (plan.appended.length > 0) {
    const seenIds = new Set(nextItems.map((item) => item.id));
    for (const entry of plan.appended) {
      if (seenIds.has(entry.id)) continue;
      const item: StaticTranscriptItem = {
        id: entry.id,
        kind: 'entry',
        entry,
      };
      const metrics = staticTranscriptItemMetrics(
        item,
        width,
        executionLabels,
        previousItem,
      );
      nextRowCount += metrics.rows;
      nextByteCount += metrics.bytes;
      nextItems = [...nextItems, item];
      previousItem = item;
      seenIds.add(entry.id);
      changed = true;
    }
  }

  const trimmed = trimStaticTranscriptItems(nextItems, {
    budgets: ringBudgets,
    executionLabels,
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
    executionLabels,
    repaintEpoch: nextRepaintEpoch,
  };
}

export function StaticConversationTranscript({
  colorEnabled,
  maxRows,
  onRenderKeyChange,
  ownerKey,
  renderKey = ownerKey,
  scrollbackStreamId,
  subagentExecutionLabels,
  width,
}: {
  readonly colorEnabled?: boolean;
  readonly maxRows?: number;
  readonly onRenderKeyChange?: () => void;
  readonly ownerKey: string;
  readonly renderKey?: string;
  readonly scrollbackStreamId: StreamTabId | undefined;
  readonly subagentExecutionLabels?: ExecutionLabels;
  readonly width?: number;
}): React.JSX.Element {
  const normalizedWidth = transcriptColumns(width);
  const streams = useSignal(streamsSignal);
  const sessionMeta = useSignal(sessionMetaSignal);
  const parentStream = useSignal(parentStreamSignal);
  const childStreamEntries = useSignal(childStreamEntriesSignal);

  const buildFreshItems = (): readonly StaticTranscriptItem[] =>
    buildStaticTranscriptItems({
      currentItems: [],
      streams,
      childStreamEntries,
      executionLabels: subagentExecutionLabels,
      meta: sessionMeta,
      maxRows,
      parentStream,
      scrollbackStreamId,
      width: normalizedWidth,
    }).items;

  const [state, setState] = useState<StaticTranscriptState>(() =>
    buildStaticTranscriptState({
      childStreamEntries,
      executionLabels: subagentExecutionLabels,
      maxRows,
      meta: sessionMeta,
      ownerKey,
      parentStream,
      repaintEpoch: 0,
      scrollbackStreamId,
      streams,
      width: normalizedWidth,
    }),
  );

  const items = state.ownerKey === ownerKey ? state.items : buildFreshItems();

  useEffect(() => {
    setState((current) =>
      advanceStaticTranscriptState(current, {
        childStreamEntries,
        executionLabels: subagentExecutionLabels,
        maxRows,
        meta: sessionMeta,
        ownerKey,
        parentStream,
        ringBudgets: DEFAULT_STATIC_TRANSCRIPT_RING_BUDGETS,
        scrollbackStreamId,
        streams,
        width: normalizedWidth,
      }),
    );
  }, [
    childStreamEntries,
    maxRows,
    ownerKey,
    parentStream,
    scrollbackStreamId,
    sessionMeta,
    streams,
    subagentExecutionLabels,
    normalizedWidth,
  ]);

  const repaintKey = `${renderKey}:${state.repaintEpoch}`;
  const previousRenderKey = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const previous = previousRenderKey.current;
    previousRenderKey.current = repaintKey;
    if (previous !== undefined && previous !== repaintKey) {
      onRenderKeyChange?.();
    }
  }, [onRenderKeyChange, repaintKey]);

  // Keep our scrollback state readonly and adapt once at the Ink boundary.
  // `<Static>` declares `items: T[]`; memoizing the defensive copy avoids the
  // old O(history) spread on unrelated renders without exposing state to a
  // mutable third-party prop.
  const staticItems = useMemo(() => [...items], [items]);

  return (
    <Static
      key={`transcript:${renderKey}:${normalizedWidth}:${state.repaintEpoch}`}
      items={staticItems}
    >
      {(item: StaticTranscriptItem, index: number) => (
        <Box key={item.id} flexDirection="column">
          <StaticTranscriptItemContent
            colorEnabled={colorEnabled}
            executionLabels={subagentExecutionLabels}
            item={item}
            previousItem={staticItems[index - 1]}
            width={normalizedWidth}
          />
        </Box>
      )}
    </Static>
  );
}
