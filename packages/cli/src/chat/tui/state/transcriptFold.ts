/**
 * Pure transcript-fold engine.
 *
 * Projects `StreamLogEntry`s into shared `TranscriptRow`s (`@shared/transcript`)
 * and folds `StreamLogDelta`s into the per-stream `TranscriptFoldState` items
 * array.
 * This module carries no module-global mutable state — every mutation happens
 * on the `TranscriptFoldState` passed in, which lives on the stream's slice
 * (`cliState`) — so review is just the fold rules, and the projection caches
 * are torn down only where the state is (stream removal, transcript release,
 * CLI-state reset). The store subscription, batched drain, and
 * sync/eviction/focus plumbing that drive this engine live in
 * `subscribeStreamLog.ts`.
 */

import { safeTerminalText } from '@cli/runtime/terminalText';
import { createLog } from '@logger/logUtils';
import { redactSecrets } from '@logger/redaction';
import { projectWorkflowCallEntry } from '@model/projectWorkflowCallEntry';
import {
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  isPlainAgentIdentity,
  type RunIdentity,
  type StreamLogEntry,
  type TaskGroup,
  type WorkflowPlanMarker,
} from '@shared/schemas';
import {
  compactionActivityRow,
  isSettledRow,
  projectTranscriptRow,
  promotesOnlyOnTypedTerminalState,
  type TranscriptRow,
  type TranscriptRowKind,
} from '@shared/transcript';
import {
  applyCompactionActivityEntries,
  createCompactionActivityProjection,
  settleCompactionActivities,
  type CompactionActivityProjection,
} from '@shared/streams/compactionActivityProjection';
import { upsertTaskGroupFromStreamLog } from '@shared/streams/taskGroupProjection';
import {
  workflowMarkerOf,
  type WorkflowRunModel,
} from '@shared/streams/workflowRunModel';
import type { StreamLog } from '@transcript';
import { truncateSummary } from '@utils/text/stringUtils';
import {
  isFinalizedTranscriptRow,
  isRenderableTranscriptEntry,
  transcriptRowHeadline,
} from '../panes/transcriptEntries';
import type { TranscriptFoldItem, TranscriptFoldState } from './cliState';

const logger = createLog('transcriptFold');

// Canonical dashboard rows retained when a workflow stream is compacted.
// Compaction activity passes through like a local row: a run that compacted
// its context says so on the dashboard too.
const WORKFLOW_DASHBOARD_KINDS = new Set<TranscriptRowKind>([
  'compactionActivity',
  'phase',
  'workflowTask',
]);

// Compact inactive streams must not retain an unbounded operational transcript,
// but the dashboard needs canonical phase/call identity while a child is open.
const MAX_COMPACT_WORKFLOW_DASHBOARD_ENTRIES = 2_000;

/**
 * Detached child runs that surface their full log output when focused: a
 * process stream, an external-CLI agent session, or a workflow-script run.
 * Keyed on the stream's parsed identity — never on the stream-id format.
 */
export function isFullLogChildStream(
  identity: RunIdentity | undefined,
): boolean {
  return identity !== undefined && !isPlainAgentIdentity(identity);
}

function safeWorkflowOperationalSummary(text: string): string | undefined {
  const sanitized = redactSecrets(safeTerminalText(text));
  return sanitized.trim() ? truncateSummary(sanitized, 120) : undefined;
}

export function workflowOperationalLatestLine(
  items: readonly TranscriptFoldItem[],
): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const row = items[index].rendered;
    if (row.kind === 'tool') {
      // A status line wants the tool's own account of what it is doing, not
      // the call's input preview — the tool name is the last resort.
      const line =
        safeWorkflowOperationalSummary(row.toolUse.headerSummary) ??
        safeWorkflowOperationalSummary(row.model.headerLabel);
      if (line) return line;
      continue;
    }
    if (row.kind === 'phase') {
      const line = safeWorkflowOperationalSummary(row.phaseLabel);
      if (line) return line;
      continue;
    }
    if (
      row.kind === 'error' ||
      row.kind === 'workflowTask' ||
      ((row.kind === 'assistant' || row.kind === 'log') &&
        row.messageType === MESSAGE_TYPES.DEFAULT)
    ) {
      const line = safeWorkflowOperationalSummary(transcriptRowHeadline(row));
      if (line) return line;
    }
  }
  return undefined;
}

/**
 * The transcript row a projected row paints as, or `null` when the terminal
 * has no line for it.
 *
 * One drop: a prose row whose text is invisible in a terminal — an all-ANSI or
 * zero-width chunk — never becomes a row at all, so nothing downstream has to
 * reserve space for it. Typed rows keep their membership: the projector
 * decided it, and the terminal does not re-decide.
 */
function transcriptRowForPaint(row: TranscriptRow): TranscriptRow | null {
  switch (row.kind) {
    case 'assistant':
    case 'log':
    case 'user':
    case 'error':
      return isRenderableTranscriptEntry(row) ? row : null;
    default:
      return row;
  }
}

// Whether an unpromoted row blocks the contiguous settled-prefix promotion at
// its position: it is not settled, and a final stream status cannot promote it
// either — compaction and workflow-call rows never promote on `streamFinal`
// alone, because bridge cleanup may still replace their planned/running state
// after cancellation.
function blocksSettledPrefix(
  row: TranscriptRow,
  index: number,
  total: number,
  streamFinal: boolean,
): boolean {
  if (isSettledRow(row, index < total - 1)) return false;
  return promotesOnlyOnTypedTerminalState(row) || !streamFinal;
}

// Advance the contiguous leading run of settled rows, so completed parts of a
// round flow into `<Static>` scrollback as the round progresses instead of
// piling up in the bounded live pane (where the viewport would clip the
// round's earlier content). Only a contiguous prefix is promoted: `<Static>`
// is append-only, so a row must not finalize while any earlier row is still
// pending, or insertion order would reverse.
//
// Both holders of a frontier walk this same loop — the fold over its items,
// and the no-resident-log turn boundary over the slice's rows — so the walk
// (and its start clamp) is stated once. Positions below `start` are already
// printed, so only the newly promotable tail is walked.
export function advanceSettledPrefixIndex(
  rowAt: (index: number) => TranscriptRow,
  total: number,
  start: number,
  streamFinal: boolean,
): number {
  let index = Math.min(start, total);
  while (index < total) {
    if (blocksSettledPrefix(rowAt(index), index, total, streamFinal)) break;
    index += 1;
  }
  return index;
}

// ---------------------------------------------------------------------------
// Transcript fold: incremental projections
// ---------------------------------------------------------------------------

function projectTaskGroupsIncrementally(
  fold: TranscriptFoldState,
  entries: readonly StreamLogEntry[],
): readonly TaskGroup[] {
  let state = fold.taskGroupProjection;
  if (!state) {
    state = { working: [], index: new Map(), applied: new Map(), snapshot: [] };
    fold.taskGroupProjection = state;
  }
  let changed = false;
  for (const entry of entries) {
    if (
      entry.type !== STREAM_LOG_ENTRY_TYPES.GROUP_START &&
      entry.type !== STREAM_LOG_ENTRY_TYPES.GROUP_END
    ) {
      continue;
    }
    if (state.applied.get(entry.id) === entry) continue;
    upsertTaskGroupFromStreamLog(state.working, state.index, entry);
    state.applied.set(entry.id, entry);
    changed = true;
  }
  // Fresh array only on change: the slice-unchanged check below compares the
  // snapshot by reference, replacing the former per-tick deep-equality walk.
  if (changed) state.snapshot = [...state.working];
  return state.snapshot;
}

/**
 * The newest `workflowPlan` marker in transcript order. A relaunch under the
 * same meta.name appends its own marker after the attempt it supersedes, so
 * the last one applied is the live attempt's plan — the same "newest attempt"
 * rule `workflowRunModel` applies to the cards. Markers are appended settled
 * and never patched, and the fold is last-wins, so feeding it the appended
 * tail or replaying any prefix lands on the same plan.
 */
function projectWorkflowPlanIncrementally(
  fold: TranscriptFoldState,
  entries: readonly StreamLogEntry[],
): {
  readonly workflowAttemptId: string | undefined;
  readonly workflowPlan: WorkflowPlanMarker | undefined;
} {
  for (const entry of entries) {
    const marker = workflowMarkerOf(entry);
    if (!marker) continue;
    fold.workflowAttemptId = marker.attemptId;
    if (marker.kind === 'malformedPlan') {
      // An unreadable plan is an unknown plan, not the previous attempt's.
      logger.warn(
        `Ignoring malformed workflow plan marker ${entry.id}: ${marker.error}`,
      );
      fold.workflowPlan = undefined;
    } else {
      fold.workflowPlan = marker.plan;
    }
  }
  return {
    workflowAttemptId: fold.workflowAttemptId,
    workflowPlan: fold.workflowPlan,
  };
}

function projectCompactionIncrementally(
  fold: TranscriptFoldState,
  log: StreamLog,
  streamTerminal: boolean,
): CompactionActivityProjection {
  let state = fold.compactionProjection;
  if (!state || state.appliedHead > log.size) {
    state = {
      projection: createCompactionActivityProjection(),
      appliedHead: 0,
      terminal: false,
    };
    fold.compactionProjection = state;
  }

  // Only the appended tail is read (O(delta)); in-place mutations behind the
  // head were already applied when their entries were first appended.
  applyCompactionActivityEntries(
    state.projection,
    log.getRange(state.appliedHead),
  );
  state.appliedHead = log.size;
  if (streamTerminal && !state.terminal) {
    // One settle shape across hosts: the boundary is the projection's own
    // applied head (the default) and the stream's last entry timestamp — the
    // same two facts `logSlice` passes in the progress view.
    settleCompactionActivities(state.projection, {
      ...(log.lastTimestamp === undefined
        ? {}
        : { finishedAt: log.lastTimestamp }),
    });
  }
  state.terminal = streamTerminal;
  return state.projection;
}

// ---------------------------------------------------------------------------
// Transcript fold: items maintenance
// ---------------------------------------------------------------------------

/** Per-application change summary, driving output rebuilds and cursor rescans. */
interface FoldChangeFlags {
  itemsChanged: boolean;
  /** A change touched a row the compact workflow output selects. */
  compactAffected: boolean;
  syntheticsChanged: boolean;
}

export function newFoldChangeFlags(): FoldChangeFlags {
  return {
    itemsChanged: false,
    compactAffected: false,
    syntheticsChanged: false,
  };
}

export function createTranscriptFoldState(): TranscriptFoldState {
  return {
    hydrated: false,
    logInstanceId: 0,
    emissionSeq: 0,
    items: [],
    indexById: new Map(),
    finalizedFrontier: 0,
    projectLifecycleToTaskGroups: false,
    synthetics: [],
  };
}

export function resetTranscriptFoldState(state: TranscriptFoldState): void {
  state.hydrated = false;
  state.logInstanceId = 0;
  state.emissionSeq = 0;
  state.items.length = 0;
  state.indexById.clear();
  state.finalizedFrontier = 0;
  state.synthetics = [];
  state.lastOutputFull = undefined;
  state.lastEntriesOutput = undefined;
}

/** `sortSeq`/`tieBreak`/`rank` total order over fold items. `Infinity`
 *  anchors compare as equal on the first term (NaN is falsy), falling
 *  through to the tiebreaks, which is exactly the order wanted. */
function compareFoldOrder(
  a: TranscriptFoldItem,
  b: TranscriptFoldItem,
): number {
  return a.sortSeq - b.sortSeq || a.tieBreak - b.tieBreak || a.rank - b.rank;
}

/** Upper bound: first index whose item orders strictly after `item`, so an
 *  equal-key later insert lands after its equals (stable across sources). */
function foldInsertPosition(
  items: readonly TranscriptFoldItem[],
  item: TranscriptFoldItem,
): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (compareFoldOrder(items[mid], item) <= 0) low = mid + 1;
    else high = mid;
  }
  return low;
}

function isUserLineRow(row: TranscriptRow): boolean {
  return row.kind === 'user' && transcriptRowHeadline(row).trim().length > 0;
}

/** A model reply with visible text, before the promotion question is asked. */
function isResponseRow(row: TranscriptRow): boolean {
  return (
    (row.kind === 'assistant' || row.kind === 'log') &&
    row.messageType === MESSAGE_TYPES.MODEL_RESPONSE &&
    transcriptRowHeadline(row).trim().length > 0
  );
}

function isFinalizedResponseAt(
  state: TranscriptFoldState,
  row: TranscriptRow,
  index: number,
): boolean {
  return (
    isResponseRow(row) &&
    isFinalizedTranscriptRow(row, index, state.finalizedFrontier)
  );
}

function touchesCompactOutput(row: TranscriptRow): boolean {
  return row.origin === 'local' || WORKFLOW_DASHBOARD_KINDS.has(row.kind);
}

/** The stream's latest conversation line: the headline of the newest row that
 *  is either a user instruction or a settled model reply. A row cannot be
 *  both, so the highest-indexed match decides — one backwards scan, stopping
 *  at the first hit. Both predicates already require a non-empty headline, so
 *  `undefined` means "no such row", never "empty text". */
export function latestConversationLine(
  state: TranscriptFoldState,
): string | undefined {
  const items = state.items;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const row = items[index].rendered;
    if (isUserLineRow(row) || isFinalizedResponseAt(state, row, index)) {
      return transcriptRowHeadline(row);
    }
  }
  return undefined;
}

function reindexFoldFrom(state: TranscriptFoldState, from: number): void {
  for (let index = from; index < state.items.length; index += 1) {
    state.indexById.set(state.items[index].rendered.id, index);
  }
}

function insertFoldItem(
  state: TranscriptFoldState,
  item: TranscriptFoldItem,
  flags: FoldChangeFlags,
): void {
  const items = state.items;
  const last = items.at(-1);
  const pos =
    last === undefined || compareFoldOrder(last, item) <= 0
      ? items.length
      : foldInsertPosition(items, item);
  if (pos === items.length) {
    items.push(item);
    state.indexById.set(item.rendered.id, pos);
  } else {
    items.splice(pos, 0, item);
    reindexFoldFrom(state, pos);
    if (pos < state.finalizedFrontier) state.finalizedFrontier = pos;
  }
  flags.itemsChanged = true;
  if (touchesCompactOutput(item.rendered)) flags.compactAffected = true;
}

function replaceFoldRendered(
  state: TranscriptFoldState,
  pos: number,
  rendered: TranscriptRow,
  flags: FoldChangeFlags,
): void {
  const item = state.items[pos];
  const previous = item.rendered;
  item.rendered = rendered;
  flags.itemsChanged = true;
  if (touchesCompactOutput(previous) || touchesCompactOutput(rendered)) {
    flags.compactAffected = true;
  }
  // The frontier is never retracted here: a row below it has already been
  // printed into append-only `<Static>` scrollback and cannot be un-printed,
  // whatever its replacement says about itself.
}

function removeFoldItemAt(
  state: TranscriptFoldState,
  pos: number,
  flags: FoldChangeFlags,
): void {
  const [removed] = state.items.splice(pos, 1);
  state.indexById.delete(removed.rendered.id);
  reindexFoldFrom(state, pos);
  if (pos < state.finalizedFrontier) state.finalizedFrontier -= 1;
  flags.itemsChanged = true;
  if (touchesCompactOutput(removed.rendered)) flags.compactAffected = true;
}

/**
 * The promotion cursor after the items array was rebuilt under it, given the
 * ids the promotion had already printed. A printed row can never be
 * un-printed, so the frontier is carried across the reshuffle rather than
 * re-derived from a `streamFinal` that may since have gone false; a local row
 * spliced into the printed prefix joins it (local rows settle on arrival).
 */
function carriedPromotionFrontier(
  items: readonly TranscriptFoldItem[],
  promotedIds: ReadonlySet<string>,
): number {
  let frontier = 0;
  while (
    frontier < items.length &&
    (items[frontier].rank === 2 || promotedIds.has(items[frontier].rendered.id))
  ) {
    frontier += 1;
  }
  return frontier;
}

// ---------------------------------------------------------------------------
// Transcript fold: change application
// ---------------------------------------------------------------------------

export interface FoldContext {
  readonly log: StreamLog;
  /** Current slice entries, consulted only for CLI-local rows. */
  readonly sliceEntries: readonly TranscriptRow[];
  /** Settled-prefix promotion signal: real settlement OR a turn-boundary
   *  caller's `forceFinal`. Never drives compaction settlement. */
  readonly streamFinal: boolean;
  /** The stream's lifecycle actually reached a settlement phase. Only this
   *  settles compaction activities: a turn-boundary `forceFinal` while a
   *  compaction is still running must not record it as interrupted — its
   *  completion event is still to come. */
  readonly streamSettled: boolean;
  /** Resync only: previous rows by id, so a closed phase keeps its inherited
   *  counts across a rebuild. */
  readonly inherit?: ReadonlyMap<string, TranscriptRow>;
  /** Resync only: ids the promotion had already printed into `<Static>`, so
   *  the frontier survives a rebuild instead of being re-derived from a
   *  `streamFinal` that may since have gone false. */
  readonly promotedIds?: ReadonlySet<string>;
  readonly flags: FoldChangeFlags;
}

/** Merge two seqNo-ascending change lists into one seqNo-ascending pass. */
function mergeChangedBySeqNo(
  dirtied: readonly StreamLogEntry[],
  appended: readonly StreamLogEntry[],
): readonly StreamLogEntry[] {
  if (dirtied.length === 0) return appended;
  if (appended.length === 0) return dirtied;
  const merged: StreamLogEntry[] = [];
  let d = 0;
  let a = 0;
  while (d < dirtied.length && a < appended.length) {
    merged.push(
      dirtied[d].seqNo <= appended[a].seqNo ? dirtied[d++] : appended[a++],
    );
  }
  while (d < dirtied.length) merged.push(dirtied[d++]);
  while (a < appended.length) merged.push(appended[a++]);
  return merged;
}

/** Fold one changed (appended or dirtied) log entry into the items array. */
function applyChangedLogEntry(
  state: TranscriptFoldState,
  entry: StreamLogEntry,
  ctx: FoldContext,
): void {
  const trackedPos = state.indexById.get(entry.id);
  const existingPos =
    trackedPos !== undefined && state.items[trackedPos].rank === 1
      ? trackedPos
      : undefined;
  const drop = (): void => {
    if (existingPos !== undefined)
      removeFoldItemAt(state, existingPos, ctx.flags);
  };

  const prev =
    existingPos !== undefined
      ? state.items[existingPos].rendered
      : ctx.inherit?.get(entry.id);
  // Workflow-call model ids reach the shared projection already resolved to
  // their runtime display label; the projection itself never reaches into the
  // model registry.
  const row = projectTranscriptRow(projectWorkflowCallEntry(entry), {
    ...(prev ? { previousRow: prev } : {}),
    projectLifecycleToTaskGroups: state.projectLifecycleToTaskGroups,
  });
  if (row === undefined) {
    drop();
    return;
  }
  const rendered = transcriptRowForPaint(row);
  if (rendered === null) {
    drop();
    return;
  }
  if (existingPos !== undefined) {
    replaceFoldRendered(state, existingPos, rendered, ctx.flags);
  } else {
    insertFoldItem(
      state,
      { rendered, sortSeq: entry.seqNo, tieBreak: 0, rank: 1 },
      ctx.flags,
    );
  }
}

/** Reconcile projected compaction blocks into their transcript rows. */
function reconcileCompactionRows(
  state: TranscriptFoldState,
  projection: CompactionActivityProjection,
  flags: FoldChangeFlags,
): void {
  for (const block of projection.blocks) {
    const row = compactionActivityRow(block);
    const pos = state.indexById.get(row.id);
    if (pos !== undefined && state.items[pos].block === block) continue;
    const rendered = transcriptRowForPaint(row);
    if (rendered === null) continue;
    if (pos !== undefined) {
      state.items[pos].block = block;
      replaceFoldRendered(state, pos, rendered, flags);
    } else {
      insertFoldItem(
        state,
        { rendered, sortSeq: block.startPosition, tieBreak: 0, rank: 0, block },
        flags,
      );
    }
  }
}

/**
 * Reconcile CLI-local rows from the slice into the items array. Local rows are
 * CLI-owned objects appended to `slice.entries` out of band, so the fold
 * detects them by object identity against the last reconciled list. Changes
 * are rare, user-paced events; the bulk rebuild keeps insertion-order
 * tiebreaks exact and recomputes the position cursors in one pass.
 */
function reconcileSynthetics(
  state: TranscriptFoldState,
  sliceEntries: readonly TranscriptRow[],
  flags: FoldChangeFlags,
): void {
  const current: TranscriptRow[] = [];
  for (const row of sliceEntries) {
    if (row.origin === 'local') current.push(row);
  }
  const previous = state.synthetics;
  if (
    current.length === previous.length &&
    current.every((row, index) => row === previous[index])
  ) {
    return;
  }
  flags.syntheticsChanged = true;
  flags.itemsChanged = true;
  flags.compactAffected = true;
  const promotedIds = new Set<string>();
  for (let index = 0; index < state.finalizedFrontier; index += 1) {
    promotedIds.add(state.items[index]!.rendered.id);
  }
  let removed = false;
  for (let index = state.items.length - 1; index >= 0; index -= 1) {
    if (state.items[index].rank === 2) {
      state.items.splice(index, 1);
      removed = true;
    }
  }
  // Stale ids of removed rows must leave the map; positions are rebuilt by
  // the unconditional reindex after the inserts below.
  if (removed) state.indexById.clear();
  for (const [index, row] of current.entries()) {
    const item: TranscriptFoldItem = {
      rendered: row,
      // Local rows are positioned by the log head captured when the CLI
      // appended them, alongside the ordered log entries.
      sortSeq: row.seqNo ?? Number.POSITIVE_INFINITY,
      tieBreak: index + 1,
      rank: 2,
    };
    const pos = foldInsertPosition(state.items, item);
    state.items.splice(pos, 0, item);
  }
  reindexFoldFrom(state, 0);
  state.finalizedFrontier = carriedPromotionFrontier(state.items, promotedIds);
  state.synthetics = current;
}

// Advance the fold's settled-prefix promotion over its items.
function advanceSettledPrefix(
  state: TranscriptFoldState,
  streamFinal: boolean,
): void {
  const items = state.items;
  state.finalizedFrontier = advanceSettledPrefixIndex(
    (index) => items[index]!.rendered,
    items.length,
    state.finalizedFrontier,
    streamFinal,
  );
}

/**
 * Apply one coalesced change set to the fold state. The from-scratch rebuild
 * is this same function fed `getRange(0)` as the appended list over a reset
 * state — the resync path and the fold share every ordering rule.
 */
export function applyStreamChanges(
  state: TranscriptFoldState,
  appended: readonly StreamLogEntry[],
  dirtied: readonly StreamLogEntry[],
  ctx: FoldContext,
): {
  taskGroups: readonly TaskGroup[];
  workflowAttemptId: string | undefined;
  workflowPlan: WorkflowPlanMarker | undefined;
  compaction: CompactionActivityProjection;
} {
  const changed = mergeChangedBySeqNo(dirtied, appended);
  const taskGroups = projectTaskGroupsIncrementally(state, changed);
  const { workflowAttemptId, workflowPlan } = projectWorkflowPlanIncrementally(
    state,
    changed,
  );
  const compaction = projectCompactionIncrementally(
    state,
    ctx.log,
    ctx.streamSettled,
  );
  for (const entry of changed) applyChangedLogEntry(state, entry, ctx);
  reconcileCompactionRows(state, compaction, ctx.flags);
  reconcileSynthetics(state, ctx.sliceEntries, ctx.flags);
  if (ctx.promotedIds) {
    // Rebuild path: carry the promotion across the reset rather than
    // re-deriving it from a `streamFinal` that may since have gone false.
    state.finalizedFrontier = carriedPromotionFrontier(
      state.items,
      ctx.promotedIds,
    );
  }
  // Promote only after the merged order is final: "is there a later entry"
  // and `<Static>` append order are both defined on the final stream order.
  advanceSettledPrefix(state, ctx.streamFinal);
  return { taskGroups, workflowAttemptId, workflowPlan, compaction };
}

/** Phase groups represented inside the already-retained dashboard rows.
 *  Stable row/group ids preserve a phase whose divider crossed the cutoff but
 *  whose task did not, without making this helper another retention owner. */
function retainedWorkflowTaskGroups(
  taskGroups: readonly TaskGroup[],
  rows: readonly TranscriptRow[],
): readonly TaskGroup[] {
  const retainedPhaseIds = new Set<string>();
  for (const row of rows) {
    if (row.kind === 'phase') retainedPhaseIds.add(row.id);
    else if (row.kind === 'workflowTask' && row.groupId !== undefined) {
      retainedPhaseIds.add(row.groupId);
    }
  }
  return taskGroups.filter(
    (group) => group.kind !== 'phase' || retainedPhaseIds.has(group.id),
  );
}

/** The bounded dashboard + local-row selection for an unfocused workflow
 *  stream, with the count of leading rows the promotion has already printed
 *  (the selection preserves order, so promoted rows stay a prefix of it). */
export function compactWorkflowEntries(
  items: readonly TranscriptFoldItem[],
  finalizedFrontier: number,
): {
  rows: TranscriptRow[];
  finalizedFrontier: number;
  dashboardTruncated: boolean;
} {
  let dashboardCount = 0;
  for (const item of items) {
    if (
      item.rendered.origin !== 'local' &&
      WORKFLOW_DASHBOARD_KINDS.has(item.rendered.kind)
    ) {
      dashboardCount += 1;
    }
  }
  let skip = Math.max(
    0,
    dashboardCount - MAX_COMPACT_WORKFLOW_DASHBOARD_ENTRIES,
  );
  const rows: TranscriptRow[] = [];
  let promoted = 0;
  for (const [index, item] of items.entries()) {
    const row = item.rendered;
    if (row.origin !== 'local') {
      if (!WORKFLOW_DASHBOARD_KINDS.has(row.kind)) continue;
      if (skip > 0) {
        skip -= 1;
        continue;
      }
    }
    if (index < finalizedFrontier && promoted === rows.length) promoted += 1;
    rows.push(row);
  }
  return {
    rows,
    finalizedFrontier: promoted,
    dashboardTruncated: dashboardCount > MAX_COMPACT_WORKFLOW_DASHBOARD_ENTRIES,
  };
}

/** Current-plan task ids that have appeared as cards. Intersecting with the
 *  plan bounds the eviction snapshot by state the slice already retains. */
export function issuedWorkflowPlanTaskIds(
  rows: readonly TranscriptRow[],
  plan: WorkflowPlanMarker | undefined,
): ReadonlySet<string> {
  if (!plan) return new Set();
  const planTaskIds = new Set(plan.tasks.map((task) => task.id));
  return new Set(
    rows.flatMap((row) =>
      row.kind === 'workflowTask' &&
      row.call.attemptId === plan.attemptId &&
      planTaskIds.has(row.call.id)
        ? [row.call.id]
        : [],
    ),
  );
}

export interface RetainedWorkflowPopupProjection {
  readonly rows: readonly TranscriptRow[];
  readonly taskGroups: readonly TaskGroup[];
  readonly plan: WorkflowPlanMarker | undefined;
  readonly retainedPhaseIds: ReadonlySet<string>;
  readonly firstPlanIndex: number;
}

/** The popup's dashboard projection, kept bounded even while its presentation
 *  lease makes the slice expose the complete transcript to Ctrl-T. */
export function retainedWorkflowPopupProjection(input: {
  readonly entries: readonly TranscriptRow[];
  readonly taskGroups: readonly TaskGroup[];
  readonly workflowPlan: WorkflowPlanMarker | undefined;
  readonly transcriptFold?: TranscriptFoldState;
}): RetainedWorkflowPopupProjection {
  const fold = input.transcriptFold;
  const fullRows = fold?.hydrated
    ? fold.items.map((item) => item.rendered)
    : input.entries;
  const compact = fold?.hydrated
    ? compactWorkflowEntries(fold.items, fold.finalizedFrontier)
    : {
        rows: input.entries,
        finalizedFrontier: 0,
        dashboardTruncated: false,
      };
  const taskGroups = retainedWorkflowTaskGroups(input.taskGroups, compact.rows);
  const retainedPhaseIds = new Set(
    taskGroups
      .filter((group) => group.kind === 'phase')
      .map((group) => group.id),
  );
  const phaseGroupWasDropped = input.taskGroups.some(
    (group) => group.kind === 'phase' && !retainedPhaseIds.has(group.id),
  );
  if (
    !input.workflowPlan ||
    (!compact.dashboardTruncated && !phaseGroupWasDropped)
  ) {
    return {
      rows: compact.rows,
      taskGroups,
      plan: input.workflowPlan,
      retainedPhaseIds,
      firstPlanIndex: 0,
    };
  }

  const attemptId = input.workflowPlan.attemptId;
  // An opened plan phase's index pins the cutoff in declared-plan order. The
  // model keeps the complete phase array so later plan-only headings retain
  // their original index/total; retainedWorkflowRunModel removes earlier ones.
  const allIndexedPhases = input.taskGroups.filter(
    (
      group,
    ): group is TaskGroup & {
      readonly index: number;
    } =>
      group.kind === 'phase' &&
      group.index !== undefined &&
      (group.attemptId === undefined || group.attemptId === attemptId),
  );
  const retainedIndexes = allIndexedPhases
    .filter((group) => retainedPhaseIds.has(group.id))
    .map((group) => group.index);
  const openedIndexes = allIndexedPhases.map((group) => group.index);
  let firstPlanIndex = 0;
  if (retainedIndexes.length > 0) {
    firstPlanIndex = Math.min(...retainedIndexes);
  } else if (openedIndexes.length > 0) {
    firstPlanIndex = Math.max(...openedIndexes) + 1;
  }
  // A plan task that already issued outside the retained rows must not return
  // as Declared. Tasks that have not issued yet remain visible. After eviction,
  // use the bounded issued-id snapshot captured before the full fold was reset.
  const issuedIds = fold?.hydrated
    ? issuedWorkflowPlanTaskIds(fullRows, input.workflowPlan)
    : (fold?.retainedWorkflowIssuedTaskIds ??
      issuedWorkflowPlanTaskIds(fullRows, input.workflowPlan));
  const retainedIds = issuedWorkflowPlanTaskIds(
    compact.rows,
    input.workflowPlan,
  );
  const tasks = input.workflowPlan.tasks.filter(
    (task) => !issuedIds.has(task.id) || retainedIds.has(task.id),
  );
  return {
    rows: compact.rows,
    taskGroups,
    plan: { ...input.workflowPlan, tasks },
    retainedPhaseIds,
    firstPlanIndex,
  };
}

/** Remove model phases outside the CLI compaction projection. The shared model
 *  still sees the original plan, preserving declared phase numbering. */
export function retainedWorkflowRunModel(
  model: WorkflowRunModel,
  projection: RetainedWorkflowPopupProjection,
): WorkflowRunModel {
  const phases = model.phases.filter(
    (phase) =>
      projection.retainedPhaseIds.has(phase.key) ||
      phase === model.unphasedPhase ||
      (!phase.opened &&
        (phase.heading.phaseIndex === undefined ||
          phase.heading.phaseIndex >= projection.firstPlanIndex)),
  );
  const declared = phases.reduce(
    (total, phase) => total + phase.declaredTasks.length,
    0,
  );
  return {
    ...model,
    phases,
    tally: { ...model.tally, declared },
  };
}
