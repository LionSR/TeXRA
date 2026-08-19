/**
 * Pure transcript-fold engine.
 *
 * Renders `StreamLogEntry`s into `ConversationEntry` rows and folds
 * `StreamLogDelta`s into the per-stream `TranscriptFoldState` items array.
 * This module carries no module-global mutable state — every mutation happens
 * on the `TranscriptFoldState` passed in, which lives on the stream's slice
 * (`cliState`) — so review is just the fold rules, and the projection caches
 * are torn down only where the state is (stream removal, transcript release,
 * CLI-state reset). The store subscription, batched drain, and
 * sync/eviction/focus plumbing that drive this engine live in
 * `subscribeStreamLog.ts`.
 */

import { safeTerminalText } from '@cli/runtime/terminalText';
import { redactSecrets } from '@logger/redaction';
import { projectWorkflowCallEntry } from '@model/projectWorkflowCallEntry';
import {
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  isPlainAgentIdentity,
  type RunIdentity,
  type StreamLogEntry,
  type TaskGroup,
} from '@shared/schemas';
import {
  compactionActivityRow,
  isSettledRow,
  projectTranscriptRow,
  promotesOnlyOnTypedTerminalState,
  type TranscriptRow,
} from '@shared/transcript';
import {
  applyCompactionActivityEntries,
  createCompactionActivityProjection,
  settleCompactionActivities,
  type CompactionActivityProjection,
} from '@shared/streams/compactionActivityProjection';
import { upsertTaskGroupFromStreamLog } from '@shared/streams/taskGroupProjection';
import type { StreamLog } from '@transcript';
import { truncateSummary } from '@utils/text/stringUtils';
import { normalizeKnownHtmlForCliMarkdown } from '../render/htmlMarkdownNormalize';
import {
  isRenderableTranscriptEntry,
  trimAssistantTranscriptLead,
} from '../panes/transcriptEntries';
import type {
  ConversationEntry,
  TranscriptFoldItem,
  TranscriptFoldState,
} from './cliState';

// Canonical dashboard rows retained when a workflow stream is compacted.
// Compaction activity passes through like a synthetic row: a run that
// compacted its context says so on the dashboard too.
const WORKFLOW_DASHBOARD_ROLES = new Set<ConversationEntry['role']>([
  'activity',
  'phase',
  'workflowTask',
]);

// Roles a workflow-agent stream keeps when it projects an operational feed
// instead of a model transcript. `activity` is here for the same reason it is
// a dashboard role: a run that compacted its context says so on every surface.
const WORKFLOW_OPERATIONAL_ROLES = new Set<ConversationEntry['role']>([
  'activity',
  'error',
  'media',
  'phase',
  'tool',
  'workflowTask',
]);

/** Membership is one allowlist; this is the container filter a workflow-agent
 *  stream applies on top of it. Script log lines stay (they are the run's
 *  narration) unless they are debug chatter. */
function isWorkflowOperationalRow(
  row: TranscriptRow,
  role: ConversationEntry['role'],
): boolean {
  if (row.kind === 'log') return row.level !== 'debug';
  return WORKFLOW_OPERATIONAL_ROLES.has(role);
}

// Compact inactive streams must not retain an unbounded operational transcript,
// but the dashboard needs canonical phase/call identity while a child is open.
const MAX_COMPACT_WORKFLOW_DASHBOARD_ENTRIES = 2_000;

const LIVE_ACTIVITY_MESSAGE_TYPES = new Set<string>([
  MESSAGE_TYPES.THINKING,
  MESSAGE_TYPES.MODEL_RESPONSE,
  MESSAGE_TYPES.TOOL_USE,
  MESSAGE_TYPES.ERROR,
  MESSAGE_TYPES.USER_MESSAGE,
]);

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
    const entry = items[index].rendered;
    if (entry.role === 'tool') {
      // A status line wants the tool's own account of what it is doing, not
      // the call's input preview — the tool name is the last resort.
      const line =
        safeWorkflowOperationalSummary(entry.row.toolUse.headerSummary) ??
        safeWorkflowOperationalSummary(entry.row.model.headerLabel);
      if (line) return line;
      continue;
    }
    if (entry.role === 'phase') {
      const line = safeWorkflowOperationalSummary(entry.phaseLabel);
      if (line) return line;
      continue;
    }
    if (
      entry.role === 'error' ||
      entry.role === 'workflowTask' ||
      (entry.role === 'assistant' &&
        entry.messageType === MESSAGE_TYPES.DEFAULT)
    ) {
      const line = safeWorkflowOperationalSummary(entry.text);
      if (line) return line;
    }
  }
  return undefined;
}

export function logEntryStreamIsRunning(entry: StreamLogEntry): boolean {
  const data = entry.data;
  if (typeof data !== 'object' || data === null || !('status' in data)) {
    return (entry.text ?? '').trim().length > 0;
  }
  return data.status === 'running';
}

/** The role each projected row paints under. Roles are coarser than kinds:
 *  they carry the geometry, promotion and workflow-feed rules, while the row
 *  beside them carries the typed payload a renderer reads. */
const ROW_KIND_ROLE = {
  assistant: 'assistant',
  log: 'assistant',
  user: 'user',
  error: 'error',
  tool: 'tool',
  fileList: 'media',
  phase: 'phase',
  workflowTask: 'workflowTask',
  compactionActivity: 'activity',
  thinking: 'detail',
  scratchpad: 'detail',
  webSearch: 'detail',
  webFetch: 'detail',
  missingOutputs: 'detail',
  latexdiff: 'detail',
  statistics: 'detail',
  contextManagement: 'detail',
  progressStatus: 'detail',
  contextState: 'detail',
} as const satisfies Record<TranscriptRow['kind'], ConversationEntry['role']>;

// Rows whose content is fixed the moment they appear, so they print into
// `<Static>` scrollback without waiting for the settled-prefix advance.
const IMMEDIATELY_FINALIZED_ROW_KINDS = new Set<TranscriptRow['kind']>([
  'user',
  'error',
  'phase',
  'fileList',
  'missingOutputs',
  'latexdiff',
  'statistics',
  'contextManagement',
  'progressStatus',
]);

/**
 * The headline a row leads with. Body lines are painted from the row itself
 * (`transcriptRowBodyLines`) at the painter's own width — nothing is cut
 * here.
 */
function rowHeadline(row: TranscriptRow): string {
  switch (row.kind) {
    case 'assistant':
      return normalizeKnownHtmlForCliMarkdown(
        trimAssistantTranscriptLead(row.text.full),
      );
    case 'log':
      return redactSecrets(
        safeTerminalText(
          normalizeKnownHtmlForCliMarkdown(
            trimAssistantTranscriptLead(row.text.full),
          ),
        ),
      );
    // Detail rows lead with a bare noun; their `●` marker is layout geometry
    // (ROLE_GEOMETRY.detail), not part of the text.
    case 'thinking':
      return 'Thinking';
    case 'scratchpad':
      return 'Scratchpad';
    case 'user':
      return row.summary.full;
    case 'error':
      return redactSecrets(safeTerminalText(row.summary.full));
    case 'tool':
      return '';
    case 'webSearch':
    case 'webFetch':
      return row.label;
    case 'fileList':
    case 'missingOutputs':
      return row.summary;
    case 'latexdiff':
      return `Latexdiff results (${row.entries.length})`;
    case 'statistics':
      return 'Usage';
    case 'contextManagement':
    case 'compactionActivity':
      return row.label;
    case 'progressStatus':
      return safeTerminalText(row.summary.full);
    case 'workflowTask':
      return row.line;
    case 'phase':
      return row.heading;
    case 'contextState':
      return '';
  }
}

/**
 * The paint row for one projected transcript row. Never finalizes a row the
 * source has not settled: the settled-prefix promotion advances over a row
 * only once every row before it has promoted, so a fast tool can't jump ahead
 * of still-streaming assistant text in `<Static>` (which is append-only).
 */
function conversationEntryFromRow(
  row: TranscriptRow,
): ConversationEntry | null {
  // Context utilization is a status-bar fact, not a transcript line; it
  // reaches the CLI through the same projection so there is one derivation,
  // but it has no inline row on either host.
  if (row.kind === 'contextState') return null;
  const base = {
    id: row.id,
    row,
    text: rowHeadline(row),
    ...(row.seqNo !== undefined ? { sourceSeqNo: row.seqNo } : {}),
    ...(row.messageType ? { messageType: row.messageType } : {}),
    ...(row.settlementSeqNo !== undefined
      ? { settlementSeqNo: row.settlementSeqNo }
      : {}),
    ...(row.spillPath ? { spillPath: row.spillPath } : {}),
    finalized:
      row.settlementSeqNo !== undefined ||
      IMMEDIATELY_FINALIZED_ROW_KINDS.has(row.kind),
  };
  switch (row.kind) {
    case 'tool':
      return { ...base, role: 'tool', row, toolUse: row.toolUse };
    case 'fileList':
      return { ...base, role: 'media', row };
    case 'workflowTask':
      return { ...base, role: 'workflowTask', task: row.call };
    case 'compactionActivity':
      return {
        ...base,
        role: 'activity',
        activity: row.block,
        finalized: row.block.finalized,
      };
    case 'phase':
      return {
        ...base,
        role: 'phase',
        phaseLabel: row.phaseLabel,
        ...(row.phaseIndex !== undefined ? { phaseIndex: row.phaseIndex } : {}),
        ...(row.phaseTotal !== undefined ? { phaseTotal: row.phaseTotal } : {}),
        ...(row.attemptId !== undefined ? { attemptId: row.attemptId } : {}),
      };
    case 'thinking':
    case 'scratchpad':
    case 'webSearch':
    case 'webFetch':
    case 'missingOutputs':
    case 'latexdiff':
    case 'statistics':
    case 'contextManagement':
    case 'progressStatus':
      return { ...base, role: 'detail', row };
    case 'assistant':
    case 'log':
    case 'user':
    case 'error': {
      const entry: ConversationEntry = {
        ...base,
        role: ROW_KIND_ROLE[row.kind],
      };
      return isRenderableTranscriptEntry(entry) ? entry : null;
    }
  }
}

// Whether an unfinalized entry blocks the contiguous settled-prefix
// promotion at its position: it is not settled, and a final stream status
// cannot promote it either — compaction and workflow-call rows never promote
// on `streamFinal` alone, because bridge cleanup may still replace their
// planned/running state after cancellation.
function blocksSettledPrefix(
  entry: ConversationEntry,
  index: number,
  total: number,
  streamFinal: boolean,
): boolean {
  const row = entry.row;
  // CLI-synthetic rows have no source projection; they are appended already
  // finalized and never reach this predicate unsettled.
  if (row === undefined) return false;
  if (isSettledRow(row, index < total - 1)) return false;
  return promotesOnlyOnTypedTerminalState(row) || !streamFinal;
}

// Promote the contiguous leading run of settled entries to `finalized`, so
// completed parts of a round flow into `<Static>` scrollback as the round
// progresses instead of piling up in the bounded live pane (where the
// viewport would clip the round's earlier content). Only a contiguous
// prefix is promoted: `<Static>` is append-only, so an entry must not
// finalize while any earlier entry is still pending, or insertion order
// would reverse.
export function finalizeSettledPrefix(
  entries: readonly ConversationEntry[],
  streamFinal: boolean,
): ConversationEntry[] {
  let result: ConversationEntry[] | undefined;
  let sealed = false; // hit the first still-pending entry in this round
  for (const [index, entry] of entries.entries()) {
    if (entry.finalized) continue;
    if (
      sealed ||
      blocksSettledPrefix(entry, index, entries.length, streamFinal)
    ) {
      sealed = true;
      continue;
    }
    if (!result) result = [...entries];
    result[index] = { ...entry, finalized: true };
  }
  // No promotions: hand back the input as-is. The caller's `changed` check
  // is element-wise, so the same reference is safe and skips a per-tick copy.
  return result ?? (entries as ConversationEntry[]);
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
    settleCompactionActivities(state.projection, {
      throughSeqNo: log.size,
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
  userRescan: boolean;
  responseRescan: boolean;
}

export function newFoldChangeFlags(): FoldChangeFlags {
  return {
    itemsChanged: false,
    compactAffected: false,
    syntheticsChanged: false,
    userRescan: false,
    responseRescan: false,
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
    latestUserPos: -1,
    latestResponsePos: -1,
    workflowAttemptSeqNo: -1,
    workflowAttemptBoundaryDeclared: false,
    workflowOperationalOnly: false,
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
  state.latestUserPos = -1;
  state.latestResponsePos = -1;
  state.workflowAttemptId = undefined;
  state.workflowAttemptBoundaryDeclared = false;
  state.workflowAttemptSeqNo = -1;
  state.liveActivityEntry = undefined;
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

function isUserLineRow(entry: ConversationEntry): boolean {
  return entry.role === 'user' && entry.text.trim().length > 0;
}

function isFinalizedResponseRow(entry: ConversationEntry): boolean {
  return (
    entry.role === 'assistant' &&
    entry.messageType === MESSAGE_TYPES.MODEL_RESPONSE &&
    entry.finalized &&
    entry.text.trim().length > 0
  );
}

function touchesCompactOutput(entry: ConversationEntry): boolean {
  return entry.synthetic === true || WORKFLOW_DASHBOARD_ROLES.has(entry.role);
}

function findLastFoldPos(
  items: readonly TranscriptFoldItem[],
  matches: (entry: ConversationEntry) => boolean,
): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (matches(items[index].rendered)) return index;
  }
  return -1;
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
    if (state.latestUserPos >= pos) state.latestUserPos += 1;
    if (state.latestResponsePos >= pos) state.latestResponsePos += 1;
  }
  if (isUserLineRow(item.rendered) && pos > state.latestUserPos) {
    state.latestUserPos = pos;
  }
  if (isFinalizedResponseRow(item.rendered) && pos > state.latestResponsePos) {
    state.latestResponsePos = pos;
  }
  flags.itemsChanged = true;
  if (touchesCompactOutput(item.rendered)) flags.compactAffected = true;
}

function replaceFoldRendered(
  state: TranscriptFoldState,
  pos: number,
  rendered: ConversationEntry,
  flags: FoldChangeFlags,
): void {
  const item = state.items[pos];
  const previous = item.rendered;
  item.rendered = rendered;
  flags.itemsChanged = true;
  if (touchesCompactOutput(previous) || touchesCompactOutput(rendered)) {
    flags.compactAffected = true;
  }
  if (pos < state.finalizedFrontier && !rendered.finalized) {
    state.finalizedFrontier = pos;
  }
  if (pos === state.latestUserPos && !isUserLineRow(rendered)) {
    flags.userRescan = true;
  } else if (isUserLineRow(rendered) && pos > state.latestUserPos) {
    state.latestUserPos = pos;
  }
  if (pos === state.latestResponsePos && !isFinalizedResponseRow(rendered)) {
    flags.responseRescan = true;
  } else if (
    isFinalizedResponseRow(rendered) &&
    pos > state.latestResponsePos
  ) {
    state.latestResponsePos = pos;
  }
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
  if (pos === state.latestUserPos) flags.userRescan = true;
  else if (pos < state.latestUserPos) state.latestUserPos -= 1;
  if (pos === state.latestResponsePos) flags.responseRescan = true;
  else if (pos < state.latestResponsePos) state.latestResponsePos -= 1;
  flags.itemsChanged = true;
  if (touchesCompactOutput(removed.rendered)) flags.compactAffected = true;
}

/** Recompute every position-derived cursor after a bulk items rebuild. */
function recomputeFoldCursors(state: TranscriptFoldState): void {
  const items = state.items;
  let frontier = 0;
  while (frontier < items.length && items[frontier].rendered.finalized) {
    frontier += 1;
  }
  state.finalizedFrontier = frontier;
  state.latestUserPos = findLastFoldPos(items, isUserLineRow);
  state.latestResponsePos = findLastFoldPos(items, isFinalizedResponseRow);
}

// ---------------------------------------------------------------------------
// Transcript fold: change application
// ---------------------------------------------------------------------------

export interface FoldContext {
  readonly log: StreamLog;
  /** Current slice entries, consulted only for CLI-synthetic rows. */
  readonly sliceEntries: readonly ConversationEntry[];
  /** Settled-prefix promotion signal: real settlement OR a turn-boundary
   *  caller's `forceFinal`. Never drives compaction settlement. */
  readonly streamFinal: boolean;
  /** The stream's lifecycle actually reached a settlement phase. Only this
   *  settles compaction activities: a turn-boundary `forceFinal` while a
   *  compaction is still running must not record it as interrupted — its
   *  completion event is still to come. */
  readonly streamSettled: boolean;
  /** Resync only: previous rows by id, so an already-promoted row keeps its
   *  `finalized` flag and a closed phase keeps its inherited counts. */
  readonly inherit?: ReadonlyMap<string, ConversationEntry>;
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

/**
 * The tracked live-activity row was mutated away from its tracked message
 * type: re-derive it from the full log (rare, producer-anomaly path; keeps
 * the ordinary fold allocation-free).
 */
function retrackLiveActivityEntry(
  state: TranscriptFoldState,
  log: StreamLog,
): void {
  state.liveActivityEntry = log
    .getRange(0)
    .findLast((entry) =>
      LIVE_ACTIVITY_MESSAGE_TYPES.has(entry.messageType ?? ''),
    );
}

/** Tagged rows from an earlier attempt, or any tagged row after a malformed
 *  current-attempt boundary. Untagged legacy rows stay. */
function isSupersededAttemptId(
  state: TranscriptFoldState,
  attemptId: string | undefined,
): boolean {
  if (!state.workflowAttemptBoundaryDeclared || attemptId === undefined) {
    return false;
  }
  return (
    state.workflowAttemptId === undefined ||
    attemptId !== state.workflowAttemptId
  );
}

function isPriorWorkflowAttemptRow(
  state: TranscriptFoldState,
  row: TranscriptRow,
): boolean {
  if (!state.workflowAttemptBoundaryDeclared) return false;
  if (row.kind === 'phase') return isSupersededAttemptId(state, row.attemptId);
  if (row.kind === 'workflowTask') {
    return isSupersededAttemptId(state, row.call.attemptId);
  }
  return (
    row.messageType === MESSAGE_TYPES.DEFAULT &&
    row.seqNo !== undefined &&
    row.seqNo < state.workflowAttemptSeqNo
  );
}

function isPriorWorkflowAttemptItem(
  state: TranscriptFoldState,
  item: TranscriptFoldItem,
): boolean {
  const rendered = item.rendered;
  if (rendered.role === 'workflowTask') {
    return isSupersededAttemptId(state, rendered.task.attemptId);
  }
  if (rendered.role === 'phase') {
    return isSupersededAttemptId(state, rendered.attemptId);
  }
  return (
    rendered.messageType === MESSAGE_TYPES.DEFAULT &&
    rendered.sourceSeqNo !== undefined &&
    rendered.sourceSeqNo < state.workflowAttemptSeqNo
  );
}

function evictPriorWorkflowAttemptItems(
  state: TranscriptFoldState,
  flags: FoldChangeFlags,
): void {
  if (!state.workflowAttemptBoundaryDeclared) return;
  for (let index = state.items.length - 1; index >= 0; index -= 1) {
    if (isPriorWorkflowAttemptItem(state, state.items[index]!)) {
      removeFoldItemAt(state, index, flags);
    }
  }
}

/** Fold one changed (appended or dirtied) log entry into the items array. */
function applyChangedLogEntry(
  state: TranscriptFoldState,
  entry: StreamLogEntry,
  ctx: FoldContext,
): void {
  const messageType = entry.messageType ?? '';
  const data = entry.data;
  const isAttemptBoundary =
    messageType === MESSAGE_TYPES.INTERNAL &&
    typeof data === 'object' &&
    data !== null &&
    'kind' in data &&
    data.kind === 'workflowAttempt' &&
    entry.seqNo >= state.workflowAttemptSeqNo;
  if (isAttemptBoundary) {
    // A malformed declared boundary must supersede the preceding attempt.
    // Retaining its identifier would project prior-run rows as current.
    const attemptId = 'attemptId' in data ? data.attemptId : undefined;
    state.workflowAttemptId =
      typeof attemptId === 'string' && attemptId.length > 0
        ? attemptId
        : undefined;
    state.workflowAttemptBoundaryDeclared = true;
    state.workflowAttemptSeqNo = entry.seqNo;
    // The dashboard already shows only the current attempt. The live
    // transcript must match: a retry that appends a fresh attempt would
    // otherwise leave the failed first-attempt task cards and their
    // default-log leftovers in the streaming feed.
    evictPriorWorkflowAttemptItems(state, ctx.flags);
  }
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
    ...(prev?.row ? { previousRow: prev.row } : {}),
    projectLifecycleToTaskGroups: state.projectLifecycleToTaskGroups,
  });
  if (row === undefined || isPriorWorkflowAttemptRow(state, row)) {
    drop();
    return;
  }
  let rendered = conversationEntryFromRow(row);
  // Workflow-agent details are an operational feed, not a model transcript.
  // Detached workflow-script runs intentionally keep their full child log,
  // including Running/Finished and error rows.
  if (
    rendered !== null &&
    state.workflowOperationalOnly &&
    !isWorkflowOperationalRow(row, rendered.role)
  ) {
    rendered = null;
  }
  if (rendered === null) {
    drop();
    return;
  }
  // An entry the slice already promoted re-inherits the flag here, so a
  // re-render can never roll an already-printed `<Static>` row back.
  if (prev?.finalized && !rendered.finalized) {
    rendered = { ...rendered, finalized: true };
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
    const rendered = conversationEntryFromRow(row);
    if (rendered === null) continue;
    // Same container filter the log and synthetic paths apply, so a
    // workflow-agent stream has one membership rule rather than three.
    if (
      state.workflowOperationalOnly &&
      !isWorkflowOperationalRow(row, rendered.role)
    ) {
      continue;
    }
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
 * Reconcile CLI-synthetic rows from the slice into the items array. Synthetic
 * rows are CLI-owned objects appended to `slice.entries` out of band, so the
 * fold detects them by object identity against the last reconciled list.
 * Changes are rare, user-paced events; the bulk rebuild keeps insertion-order
 * tiebreaks exact and recomputes the position cursors in one pass.
 */
function reconcileSynthetics(
  state: TranscriptFoldState,
  sliceEntries: readonly ConversationEntry[],
  flags: FoldChangeFlags,
): void {
  const wOO = state.workflowOperationalOnly;
  const current: ConversationEntry[] = [];
  for (const entry of sliceEntries) {
    if (
      entry.synthetic &&
      (!wOO || WORKFLOW_OPERATIONAL_ROLES.has(entry.role))
    ) {
      current.push(entry);
    }
  }
  const previous = state.synthetics;
  if (
    current.length === previous.length &&
    current.every((entry, index) => entry === previous[index])
  ) {
    return;
  }
  flags.syntheticsChanged = true;
  flags.itemsChanged = true;
  flags.compactAffected = true;
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
  for (const [index, entry] of current.entries()) {
    const item: TranscriptFoldItem = {
      rendered: entry,
      // Synthetic (CLI-owned) rows are positioned by `syntheticAfterSeq`
      // alongside the ordered log entries.
      sortSeq: entry.syntheticAfterSeq ?? Number.POSITIVE_INFINITY,
      tieBreak: index + 1,
      rank: 2,
    };
    const pos = foldInsertPosition(state.items, item);
    state.items.splice(pos, 0, item);
  }
  reindexFoldFrom(state, 0);
  recomputeFoldCursors(state);
  flags.userRescan = false;
  flags.responseRescan = false;
  state.synthetics = current;
}

// Advance the contiguous settled-prefix promotion (same rule as
// `finalizeSettledPrefix`, folded: positions below the frontier are already
// finalized, so each application only touches newly promotable rows).
function advanceSettledPrefix(
  state: TranscriptFoldState,
  streamFinal: boolean,
  flags: FoldChangeFlags,
): void {
  const items = state.items;
  let index = state.finalizedFrontier;
  while (index < items.length) {
    const entry = items[index].rendered;
    if (entry.finalized) {
      index += 1;
      continue;
    }
    if (blocksSettledPrefix(entry, index, items.length, streamFinal)) break;
    replaceFoldRendered(state, index, { ...entry, finalized: true }, flags);
    index += 1;
  }
  state.finalizedFrontier = index;
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
  compaction: CompactionActivityProjection;
} {
  const changed = mergeChangedBySeqNo(dirtied, appended);
  let retrack = false;
  for (const entry of changed) {
    if (LIVE_ACTIVITY_MESSAGE_TYPES.has(entry.messageType ?? '')) {
      if (
        !state.liveActivityEntry ||
        entry.seqNo >= state.liveActivityEntry.seqNo
      ) {
        state.liveActivityEntry = entry;
      }
    } else if (state.liveActivityEntry?.id === entry.id) {
      retrack = true;
    }
  }
  if (retrack) retrackLiveActivityEntry(state, ctx.log);

  const taskGroups = projectTaskGroupsIncrementally(state, changed);
  const compaction = projectCompactionIncrementally(
    state,
    ctx.log,
    ctx.streamSettled,
  );
  for (const entry of changed) applyChangedLogEntry(state, entry, ctx);
  reconcileCompactionRows(state, compaction, ctx.flags);
  reconcileSynthetics(state, ctx.sliceEntries, ctx.flags);
  // Promote only after the merged order is final: "is there a later entry"
  // and `<Static>` append order are both defined on the final stream order.
  advanceSettledPrefix(state, ctx.streamFinal, ctx.flags);
  if (ctx.flags.userRescan) {
    state.latestUserPos = findLastFoldPos(state.items, isUserLineRow);
    ctx.flags.userRescan = false;
  }
  if (ctx.flags.responseRescan) {
    state.latestResponsePos = findLastFoldPos(
      state.items,
      isFinalizedResponseRow,
    );
    ctx.flags.responseRescan = false;
  }
  return { taskGroups, compaction };
}

/** The bounded dashboard + synthetic selection for an unfocused workflow stream. */
export function compactWorkflowEntries(
  items: readonly TranscriptFoldItem[],
): ConversationEntry[] {
  let dashboardCount = 0;
  for (const item of items) {
    if (
      !item.rendered.synthetic &&
      WORKFLOW_DASHBOARD_ROLES.has(item.rendered.role)
    ) {
      dashboardCount += 1;
    }
  }
  let skip = Math.max(
    0,
    dashboardCount - MAX_COMPACT_WORKFLOW_DASHBOARD_ENTRIES,
  );
  const out: ConversationEntry[] = [];
  for (const item of items) {
    const entry = item.rendered;
    if (entry.synthetic) {
      out.push(entry);
      continue;
    }
    if (!WORKFLOW_DASHBOARD_ROLES.has(entry.role)) continue;
    if (skip > 0) {
      skip -= 1;
      continue;
    }
    out.push(entry);
  }
  return out;
}
