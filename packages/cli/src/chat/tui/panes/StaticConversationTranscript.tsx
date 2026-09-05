// Session header plus finalized transcript entries. The header is the first
// static row for the active scrollback owner; finalized entries append after it
// in ordinary terminal scrollback through Ink `<Static>`. On a width change,
// the width-qualified Static identity remounts these same items so patched Ink
// can replace its accumulated static output with the new geometry.

import path from 'node:path';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text } from 'ink';

import { COLOR_HINT } from '@cli/tui/ui/colors';
import type { StreamPhase, StreamTabId } from '@shared/schemas';
import type { TranscriptRow } from '@shared/transcript';
import type { SessionView } from '@shared/session/sessionView';
import { getModelLabel } from '@shared/model/modelLabel';
import type { ExecutionLabels } from '@shared/tools/executionsDisplay';
import { safeHomedir } from '@utils/system/platformPaths';

import {
  rootStreamId as rootStreamIdSignal,
  sessionMeta as sessionMetaSignal,
  type SessionMeta,
} from '../state/cliState';
import {
  ancestorPhaseLabel,
  sessionView,
  streamLabelOf,
  streamPhaseOf,
  streamViewOf,
} from '../state/sessionView';
import { staticTranscriptEraseEpoch } from '../state/staticTranscriptRepaint';
import {
  mergeLocalNotices,
  mergedSettledRows,
  notices as noticesSignal,
  noticesFor,
} from '../state/transcript';
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
      readonly entry: TranscriptRow;
    };

interface StaticTranscriptState {
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

/** The header facts of a child scrollback stream, read from the fold. */
interface ChildHeader {
  readonly label: string;
  readonly modelLabel: string | null;
  readonly streamKind: 'workflow script' | 'subagent';
  readonly phaseText: string | undefined;
  readonly parentLabel: string;
}

/**
 * What the scrollback paints: the stream's folded rows joined with this
 * TUI's notices, its settled prefix, and the facts the session header names.
 */
interface StaticScrollbackSource {
  readonly entries: readonly TranscriptRow[] | undefined;
  readonly settledRows: number;
  readonly status: StreamPhase | undefined;
  /** A child agent whose model the fold has not folded yet: the header
   *  waits. Only an agent identity carries a model (the fold's `run.config`
   *  rule), so a process or workflow child paints at once. */
  readonly waitingForChildIdentity: boolean;
  /** The child header; undefined paints the session (root) header. */
  readonly child: ChildHeader | undefined;
  /** No scrollback stream and nothing local: `/clear` emptied the screen. */
  readonly hardReset: boolean;
}

function childHeaderFor(
  view: SessionView,
  streamId: StreamTabId | undefined,
): ChildHeader | undefined {
  const stream = streamViewOf(view, streamId);
  if (!stream?.parentId) return undefined;
  const parent = streamViewOf(view, stream.parentId);
  return {
    label: stream.label,
    modelLabel: stream.modelLabel,
    streamKind:
      stream.identity?.kind === 'multiAgentWorkflow'
        ? 'workflow script'
        : 'subagent',
    phaseText: ancestorPhaseLabel(view, stream.id),
    parentLabel: parent === undefined ? 'main' : streamLabelOf(parent),
  };
}

export function sessionHeaderIdentityLine(
  meta: SessionMeta,
  child?: ChildHeader,
): string {
  if (child) {
    const model = child.modelLabel ?? getModelLabel(meta.model || '-');
    return child.phaseText
      ? `${child.streamKind}: ${child.label} · ${child.phaseText} · parent: ${child.parentLabel} · model: ${model}`
      : `${child.streamKind}: ${child.label} · parent: ${child.parentLabel} · model: ${model}`;
  }
  const model = getModelLabel(meta.model || '-');
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
          <Text dimColor>v{meta.version}</Text> <Text>{identityLine}</Text>
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
): TranscriptRow | undefined {
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

/** Only the previous entry's bottom margin participates in collapse, so
 *  callers pass that one number rather than laying the previous item out
 *  again. `0` (the default) means there is no entry above. */
function staticTranscriptItemMetricsForPrevious(
  base: StaticTranscriptItemMetrics,
  previousMarginBottomRows = 0,
): StaticTranscriptItemMetrics {
  const marginTopRows = Math.max(
    0,
    base.declaredTopRows - previousMarginBottomRows,
  );
  return {
    ...base,
    rows: base.contentRows + marginTopRows + base.marginBottomRows,
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
  const previousEntry = entryAbove(previousItem);
  return staticTranscriptItemMetricsForPrevious(
    base,
    previousEntry === undefined
      ? 0
      : transcriptEntryMarginBottomRows(previousEntry),
  );
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
  const firstMetrics = staticTranscriptItemMetricsForPrevious(firstBase);
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
    const oldFirstBefore = staticTranscriptItemMetricsForPrevious(oldFirstBase);
    const candidateMetrics =
      staticTranscriptItemMetricsForPrevious(candidateBase);
    const oldFirstAfter = staticTranscriptItemMetricsForPrevious(
      oldFirstBase,
      candidateBase.marginBottomRows,
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
  executionLabels,
  items,
  maxRows,
  meta,
  rowCount,
  source,
  width,
}: {
  readonly byteCount: number;
  readonly executionLabels?: ExecutionLabels;
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
  const headerMetrics = staticTranscriptItemMetrics(
    header,
    width,
    executionLabels,
  );
  const firstItem = items[0];
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

  const nextItems = [header, ...items];
  return {
    items: nextItems,
    rowCount: nextRowCount,
    byteCount: nextByteCount,
    inserted: true,
  };
}

interface BuildStaticTranscriptItemsOptions {
  readonly source: StaticScrollbackSource;
  readonly executionLabels?: ExecutionLabels;
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

export function buildStaticTranscriptItems(
  options: BuildStaticTranscriptItemsOptions,
): StaticTranscriptBuildResult {
  const {
    source,
    executionLabels,
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
    executionLabels,
    items: [],
    maxRows,
    meta,
    rowCount: 0,
    source,
    width,
  });
  const items: StaticTranscriptItem[] = [...header.items];
  const orderedStaticEntries = orderedStaticTranscriptEntries(
    source.entries ?? [],
    source.settledRows,
    source.status,
  );
  const seen = new Set<string>();
  for (const entry of orderedStaticEntries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    items.push({ id: entry.id, kind: 'entry', entry });
  }

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
        <EntryErrorBoundary label={item.entry.kind}>
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
  entries: readonly TranscriptRow[] | undefined,
  settledRows: number,
  status: StreamPhase | undefined,
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
  executionLabels,
  eraseRequest,
  maxRows,
  meta,
  ownerKey,
  repaintEpoch,
  ringBudgets = DEFAULT_STATIC_TRANSCRIPT_RING_BUDGETS,
  source,
  width,
}: {
  readonly executionLabels?: ExecutionLabels;
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
    executionLabels,
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
    executionLabels,
    repaintEpoch,
    eraseRequest: eraseRequest ?? 0,
  };
}

export function advanceStaticTranscriptState(
  current: StaticTranscriptState,
  {
    executionLabels,
    eraseRequest = current.eraseRequest,
    maxRows,
    meta,
    ownerKey,
    ringBudgets = DEFAULT_STATIC_TRANSCRIPT_RING_BUDGETS,
    source,
    width,
  }: {
    readonly executionLabels?: ExecutionLabels;
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
      executionLabels,
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
    // no streams — must not bump the repaint epoch. The `<Static>` remount
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
      executionLabelsEqual(rebuilt.executionLabels, current.executionLabels) &&
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
  const labelsChanged = !executionLabelsEqual(
    executionLabels,
    current.executionLabels,
  );
  const layoutChanged = width !== current.layoutWidth || labelsChanged;
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
    executionLabels,
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
    eraseRequest,
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
  const view = useSignal(sessionView());
  const allNotices = useSignal(noticesSignal);
  const rootStreamId = useSignal(rootStreamIdSignal);
  const sessionMeta = useSignal(sessionMetaSignal);
  const eraseRequest = useSignal(staticTranscriptEraseEpoch);
  const source = useMemo((): StaticScrollbackSource => {
    const stream = streamViewOf(view, scrollbackStreamId);
    const streamNotices = noticesFor(allNotices, scrollbackStreamId);
    const entries =
      stream === undefined && streamNotices.length === 0
        ? undefined
        : mergeLocalNotices(stream?.transcript.rows ?? [], streamNotices);
    return {
      entries,
      settledRows: mergedSettledRows(
        stream?.transcript.rows ?? [],
        stream?.transcript.settledRows ?? 0,
        streamNotices,
      ),
      status: streamPhaseOf(stream),
      waitingForChildIdentity:
        stream !== undefined &&
        stream.parentId !== null &&
        stream.identity?.kind === 'agent' &&
        stream.model === null,
      child: childHeaderFor(view, scrollbackStreamId),
      hardReset:
        scrollbackStreamId === undefined &&
        rootStreamId === undefined &&
        allNotices.length === 0,
    };
  }, [allNotices, rootStreamId, scrollbackStreamId, view]);
  const [state, setState] = useState<StaticTranscriptState>(() =>
    buildStaticTranscriptState({
      eraseRequest,
      executionLabels: subagentExecutionLabels,
      maxRows,
      meta: sessionMeta,
      ownerKey,
      repaintEpoch: 0,
      source,
      width: normalizedWidth,
    }),
  );
  const items =
    state.ownerKey === ownerKey
      ? state.items
      : buildStaticTranscriptItems({
          source,
          executionLabels: subagentExecutionLabels,
          meta: sessionMeta,
          maxRows,
          width: normalizedWidth,
        }).items;
  useEffect(() => {
    setState((current) =>
      advanceStaticTranscriptState(current, {
        eraseRequest,
        executionLabels: subagentExecutionLabels,
        maxRows,
        meta: sessionMeta,
        ownerKey,
        source,
        width: normalizedWidth,
      }),
    );
  }, [
    eraseRequest,
    maxRows,
    ownerKey,
    sessionMeta,
    source,
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
