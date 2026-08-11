// Mirror StreamLogStore user/model/tool entries into
// `streams[].entries` (state/cliState.ts). Approval/permission
// entries land in side panels and modals; tool rows render inline alongside
// assistant prose.
//
// The projection is a fold over the store's entry-level change feed: every
// `StreamLogStore.onChange` emission carries a `StreamLogDelta` (appended
// entries + dirtied entries by value + a monotonic emission seq), and the
// per-stream `TranscriptFoldState` on the slice is advanced in O(delta) per
// tick. A fresh consumer, an emission gap, a reset emission, or a
// projection-mode flip rebuilds the state from `getRange(0)` through the
// same application path — the from-scratch build IS the resync path.
//
// Secrets are redacted at record time by TexraTranscriptRecorder, which is
// what every host and the HTML export share. The `redactSecrets` calls below
// remain only to cover rows persisted before that landed; they are idempotent
// on already-redacted text.

import { isDeepStrictEqual } from 'node:util';

import { defaultSession } from '@agent/runtime/SessionHandle';
import { appendCliApiSwitchHint } from '@cli/runtime/approval/approvalPrompts';
import { TOOL_OUTPUT_CORNER } from '@cli/tui/ui/glyphs';
import { redactSecrets } from '@logger/redaction';
import {
  ActiveSkillsSnapshotSchema,
  AgentCategory,
  ErrorLogDataSchema,
  FileListEntrySchema,
  GroupLogPayloadSchema,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  TOOL_USE_STATUS,
  WorkflowCallProgressSchema,
  isTerminalWorkflowCallProgress,
  type StreamLogEntry,
  type StreamTabId,
  type TaskGroup,
} from '@shared/schemas';
import {
  hasIncompleteEmbeddedSubagentFollowup,
  summarizeFollowupMessage,
} from '@shared/subagentFollowup';
import { normalizeToolUseData } from '@shared/toolUse';
import { formatWorkflowCallLine } from '@shared/copy/workflowCall';
import {
  applyCompactionActivityEntries,
  COMPACTION_ACTIVITY_LABEL,
  createCompactionActivityProjection,
  settleCompactionActivities,
  type CompactionActivityProjection,
} from '@shared/streams/compactionActivityProjection';
import {
  isActivePhase,
  isTranscriptSettlementPhase,
} from '@shared/streams/streamStatus';
import { upsertTaskGroupFromStreamLog } from '@shared/streams/taskGroupProjection';
import {
  StreamLogDeltaBuffer,
  type StreamLog,
  type StreamLogDelta,
} from '@transcript';
import { createFlushableDebounce } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { truncateSummary } from '@utils/text/stringUtils';
import { normalizeKnownHtmlForCliMarkdown } from '../render/htmlMarkdownNormalize';
import { safeTerminalText } from '../render/terminalText';
import {
  isRenderableTranscriptEntry,
  trimAssistantTranscriptLead,
} from '../panes/transcriptEntries';
import {
  activeStreamId,
  focusStream,
  getCliStateGeneration,
  isCliStreamRetired,
  patchStream,
  registerCliStateResetHook,
  setTransientNotice,
  streams,
  type ConversationEntry,
  type LoadedImage,
  type StreamSlice,
  type TranscriptFoldItem,
  type TranscriptFoldState,
} from './cliState';
import { isChildStreamRemoved } from './childExecutions';
import { subscribeToSignalChanges } from './signalSubscription';

const MAX_ERROR_DETAIL_LENGTH = 240;

/**
 * Project successful local context-media preparation. FILE_LIST does not
 * claim that a remote provider subsequently accepted the attachment.
 */
function projectFileListImages(data: unknown): LoadedImage[] {
  if (!Array.isArray(data)) return [];

  const images: LoadedImage[] = [];
  const seen = new Set<string>();
  for (const candidate of data) {
    const entry = FileListEntrySchema.safeParse(candidate);
    if (
      !entry.success ||
      !entry.data.ok ||
      entry.data.media?.kind !== 'image'
    ) {
      continue;
    }
    if (!entry.data.path.trim()) continue;
    const image = {
      path: entry.data.path,
      sizeBytes: entry.data.media.sizeBytes,
    };
    const key = `${image.path}\u0000${image.sizeBytes}`;
    if (seen.has(key)) continue;
    seen.add(key);
    images.push(image);
  }
  return images;
}

const TRANSCRIPT_MESSAGE_TYPES = new Set<string>([
  MESSAGE_TYPES.ERROR,
  MESSAGE_TYPES.FILE_LIST,
  MESSAGE_TYPES.MODEL_RESPONSE,
  MESSAGE_TYPES.TOOL_USE,
  MESSAGE_TYPES.USER_MESSAGE,
]);

const CHILD_STREAM_LOG_MESSAGE_TYPES = new Set<string>([
  ...TRANSCRIPT_MESSAGE_TYPES,
  MESSAGE_TYPES.DEFAULT,
  MESSAGE_TYPES.WORKFLOW_TASK,
]);

// Canonical dashboard rows retained when a workflow stream is compacted.
const WORKFLOW_DASHBOARD_ROLES = new Set<ConversationEntry['role']>([
  'phase',
  'workflowTask',
]);

// Roles a workflow-agent stream keeps when it projects an operational feed
// instead of a model transcript.
const WORKFLOW_OPERATIONAL_ROLES = new Set<ConversationEntry['role']>([
  'error',
  'media',
  'phase',
  'tool',
  'workflowTask',
]);

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
function isFullLogChildStream(
  slice: Pick<StreamSlice, 'identity'> | undefined,
): boolean {
  const identity = slice?.identity;
  return (
    identity !== undefined &&
    !(identity.kind === 'agent' && identity.tool === undefined)
  );
}

function safeWorkflowOperationalSummary(text: string): string | undefined {
  const sanitized = redactSecrets(safeTerminalText(text));
  return sanitized.trim() ? truncateSummary(sanitized, 120) : undefined;
}

function workflowOperationalLatestLine(
  items: readonly TranscriptFoldItem[],
): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const entry = items[index].rendered;
    if (entry.role === 'tool') {
      const line =
        safeWorkflowOperationalSummary(entry.toolUse.headerSummary) ??
        safeWorkflowOperationalSummary(entry.toolUse.toolName);
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

function logEntryStreamIsRunning(entry: StreamLogEntry): boolean {
  const data = entry.data;
  if (typeof data !== 'object' || data === null || !('status' in data)) {
    return (entry.text ?? '').trim().length > 0;
  }
  return data.status === 'running';
}

/**
 * A phase group header — the `stage.start`/`stage.end` rows a workflow-script
 * run emits per `phase()` (recorded as GROUP_START then upserted in place to
 * GROUP_END with `data.kind === 'phase'`). Detected by `kind`, not entry
 * `type`, so the header keeps its distinct role after the phase closes.
 */
function phaseGroupData(
  entry: StreamLogEntry,
): { index?: number; total?: number } | null {
  if (
    entry.type !== STREAM_LOG_ENTRY_TYPES.GROUP_START &&
    entry.type !== STREAM_LOG_ENTRY_TYPES.GROUP_END
  ) {
    return null;
  }
  // Same tolerant parse `updateTaskGroups` (progress-view logSlice) uses for
  // the identical group-log payload: per-field `.catch(undefined)` so a
  // malformed `index`/`total` drops just that field, not the whole header.
  const { kind, index, total } = GroupLogPayloadSchema.catch({}).parse(
    entry.data,
  );
  if (kind !== 'phase') return null;
  return {
    ...(index !== undefined ? { index } : {}),
    ...(total !== undefined ? { total } : {}),
  };
}

function logEntryRole(
  messageType: string | undefined,
): 'assistant' | 'error' | 'user' {
  if (messageType === MESSAGE_TYPES.USER_MESSAGE) return 'user';
  if (messageType === MESSAGE_TYPES.ERROR) return 'error';
  return 'assistant';
}

function renderLogEntryText(
  role: 'error' | 'user',
  text: string,
  data: unknown,
): string {
  switch (role) {
    case 'error': {
      const safeSummary = redactSecrets(safeTerminalText(text));
      const parsed = ErrorLogDataSchema.safeParse(data);
      if (!parsed.success) return appendCliApiSwitchHint(safeSummary);

      const detail = truncateSummary(
        redactSecrets(safeTerminalText(parsed.data.message)),
        MAX_ERROR_DETAIL_LENGTH,
      );
      const withDetail = detail
        ? `${safeSummary}\n${TOOL_OUTPUT_CORNER} ${detail}`
        : safeSummary;
      return appendCliApiSwitchHint(withDetail, parsed.data.exhaustionReason);
    }
    case 'user':
      return summarizeFollowupMessage(text);
  }
}

/**
 * Fields every {@link ConversationEntry} shares, regardless of role: the
 * source identity plus the two spreads (`messageType`, `settlementSeqNo`)
 * that must stay absent — not merely `undefined` — when the source entry
 * doesn't carry them, matching {@link ConversationEntry}'s optional-key shape.
 */
function baseLogEntryFields<R extends ConversationEntry['role']>(
  entry: StreamLogEntry,
  role: R,
  text: string,
) {
  return {
    id: entry.id,
    sourceSeqNo: entry.seqNo,
    role,
    text,
    ...(entry.messageType ? { messageType: entry.messageType } : {}),
    ...(entry.settlementSeqNo !== undefined
      ? { settlementSeqNo: entry.settlementSeqNo }
      : {}),
  };
}

/**
 * Renders a log entry from scratch. `prev` is consulted only for phase
 * count inheritance (a GROUP_END row carries no index/total of its own);
 * finalization here is source-owned only — the fold re-applies inherited
 * promotion at the row's slot, so an already-promoted row never rolls back.
 */
function renderLogEntryFresh(
  entry: StreamLogEntry,
  prev: ConversationEntry | undefined,
  projectLifecycleToTaskGroups: boolean,
): ConversationEntry | null {
  if (entry.messageType === MESSAGE_TYPES.FILE_LIST) {
    const images = projectFileListImages(entry.data);
    if (images.length === 0) return null;
    const next: ConversationEntry = {
      ...baseLogEntryFields(entry, 'media', ''),
      finalized: true,
      images,
    };
    return next;
  }

  if (entry.messageType === MESSAGE_TYPES.TOOL_USE) {
    const toolUse = normalizeToolUseData(entry.data);
    // Drop malformed tool entries rather than crash. The progress view
    // does the same — a bad payload shouldn't take down the transcript.
    if (!toolUse) return null;
    // Never finalize here. The settled-prefix promotion advances over a tool
    // row only once it completes AND every entry before it has promoted, so a
    // fast tool can't jump ahead of still-streaming assistant text in
    // `<Static>` (which is append-only).
    const next: ConversationEntry = {
      ...baseLogEntryFields(entry, 'tool', ''),
      finalized: entry.settlementSeqNo !== undefined,
      toolUse,
    };
    return next;
  }

  if (entry.messageType === MESSAGE_TYPES.WORKFLOW_TASK) {
    const parsed = WorkflowCallProgressSchema.safeParse(entry.data);
    if (!parsed.success) return null;
    const call = parsed.data;
    const next: ConversationEntry = {
      ...baseLogEntryFields(
        entry,
        'workflowTask',
        formatWorkflowCallLine(call),
      ),
      finalized: entry.settlementSeqNo !== undefined,
      task: call,
    };
    return next;
  }

  // A phase header is immutable at GROUP_START and therefore printable
  // immediately. Its source-owned settlement order keeps cold reconstruction
  // identical to the live append-only transcript even when planned call rows
  // were recorded earlier.
  const phaseData = phaseGroupData(entry);
  if (phaseData) {
    const phaseLabel = entry.text ?? '';
    if (phaseLabel.trim().length === 0) return null;
    // GROUP_END (phase close) carries no index/total; keep the counts the
    // GROUP_START row established so `(i/n)` doesn't vanish when a phase ends.
    const prevPhase = prev?.role === 'phase' ? prev : undefined;
    const phaseIndex = phaseData.index ?? prevPhase?.phaseIndex;
    const phaseTotal = phaseData.total ?? prevPhase?.phaseTotal;
    const next: ConversationEntry = {
      ...baseLogEntryFields(entry, 'phase', phaseLabel),
      finalized: true,
      phaseLabel,
      ...(phaseIndex !== undefined ? { phaseIndex } : {}),
      ...(phaseTotal !== undefined ? { phaseTotal } : {}),
    };
    return next;
  }

  // Workflow run/round/session lifecycle rows are projected into `taskGroups`,
  // whose focused renderer joins them with artifacts. Other full-log children
  // have no such renderer, so their lifecycle headings remain transcript rows.
  if (
    projectLifecycleToTaskGroups &&
    (entry.type === STREAM_LOG_ENTRY_TYPES.GROUP_START ||
      entry.type === STREAM_LOG_ENTRY_TYPES.GROUP_END)
  ) {
    return null;
  }

  const text = entry.text ?? '';
  const role = logEntryRole(entry.messageType);
  let assistantTranscript: string | undefined;
  let renderedText: string;
  if (role === 'assistant') {
    assistantTranscript = trimAssistantTranscriptLead(text);
    renderedText = normalizeKnownHtmlForCliMarkdown(assistantTranscript);
  } else {
    renderedText = renderLogEntryText(role, text, entry.data);
  }
  if (
    role === 'assistant' &&
    entry.messageType === MESSAGE_TYPES.DEFAULT &&
    entry.type === STREAM_LOG_ENTRY_TYPES.LOG
  ) {
    renderedText = redactSecrets(safeTerminalText(renderedText));
  }
  // Assistant text is promoted by the settled-prefix advance once the model
  // moves on to a later entry. User/error rows can't change after they
  // appear, so they finalize immediately.
  const finalized = entry.settlementSeqNo !== undefined || role !== 'assistant';
  const next: ConversationEntry = {
    ...baseLogEntryFields(entry, role, renderedText),
    ...(assistantTranscript !== undefined &&
    hasIncompleteEmbeddedSubagentFollowup(assistantTranscript)
      ? { pendingEmbeddedSubagentFollowup: true }
      : {}),
    finalized,
  };
  if (!isRenderableTranscriptEntry(next)) return null;
  return next;
}

// An entry is "settled" once its content can no longer change, so it is
// safe to print once into `<Static>` scrollback:
//   - user / error: fixed the moment they appear.
//   - workflow call: fixed once its typed state reaches a terminal status.
//   - assistant: frozen once the model emits a later entry (more text or a
//     tool call). The trailing block may still be streaming.
//   - tool: frozen once its result lands (status COMPLETED).
function isSettledEntry(
  entry: ConversationEntry,
  index: number,
  total: number,
): boolean {
  switch (entry.role) {
    case 'activity':
      return entry.activity.finalized;
    case 'user':
    case 'error':
    case 'phase':
    case 'media':
      return true;
    case 'tool':
      return (
        entry.toolUse.status === TOOL_USE_STATUS.COMPLETED ||
        entry.toolUse.status === TOOL_USE_STATUS.FAILED
      );
    case 'workflowTask':
      return isTerminalWorkflowCallProgress(entry.task);
    case 'assistant':
      return !entry.pendingEmbeddedSubagentFollowup && index < total - 1;
  }
}

// Promote the contiguous leading run of settled entries to `finalized`, so
// completed parts of a round flow into `<Static>` scrollback as the round
// progresses instead of piling up in the bounded live pane (where the
// viewport would clip the round's earlier content). Only a contiguous
// prefix is promoted: `<Static>` is append-only, so an entry must not
// finalize while any earlier entry is still pending, or insertion order
// would reverse. A final stream status settles trailing assistant/tool rows,
// but not a workflow call: bridge cleanup may still replace its
// planned/running state after cancellation.
export function finalizeSettledPrefix(
  entries: readonly ConversationEntry[],
  streamFinal: boolean,
): ConversationEntry[] {
  let result: ConversationEntry[] | undefined;
  let sealed = false; // hit the first still-pending entry in this round
  for (const [index, entry] of entries.entries()) {
    if (entry.finalized) continue;
    const settled = isSettledEntry(entry, index, entries.length);
    if (
      sealed ||
      ((entry.role === 'activity' || entry.role === 'workflowTask') &&
        !settled) ||
      (!streamFinal && !settled)
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

// Coalesce bursts into a single render without visibly delaying the
// first paint. 200ms looks like a hang on short replies (an entire reply
// can land before the first sync fires); one animation frame is enough
// to batch chunks and keeps the transcript feeling live.
const STREAM_SYNC_THROTTLE_MS = 16;

/**
 * Incremental task-group projection state, kept beside the slice: the
 * upsert engine's mutable working set plus the immutable `snapshot` the
 * slice holds. `applied` remembers the last log-entry object applied per
 * group row — `StreamLog` replaces the entry object on every update
 * (including the in-place GROUP_START → GROUP_END upsert at stage end), so
 * a reference change is exactly a content change and only new/changed rows
 * are fed to `upsertTaskGroupFromStreamLog`, never a full re-projection.
 */
interface TaskGroupProjectionState {
  readonly working: TaskGroup[];
  readonly index: Map<string, number>;
  readonly applied: Map<string, StreamLogEntry>;
  snapshot: readonly TaskGroup[];
}

const TASK_GROUP_PROJECTIONS = new Map<StreamTabId, TaskGroupProjectionState>();

interface CompactionProjectionState {
  readonly projection: CompactionActivityProjection;
  appliedHead: number;
  terminal: boolean;
}

const COMPACTION_PROJECTIONS = new Map<
  StreamTabId,
  CompactionProjectionState
>();

/**
 * Store-emitted deltas awaiting the next batched sync, coalesced per stream.
 * Written by the `onChange` subscriber; drained by `syncStreamLog`, so an
 * out-of-band sync (status transition, focus switch, tests) folds the same
 * buffered changes instead of rescanning the log.
 */
interface PendingStreamDeltas {
  readonly buffer: StreamLogDeltaBuffer;
  generation: number;
}

const PENDING_DELTAS = new Map<StreamTabId, PendingStreamDeltas>();

registerCliStateResetHook(() => {
  TASK_GROUP_PROJECTIONS.clear();
  COMPACTION_PROJECTIONS.clear();
  PENDING_DELTAS.clear();
});

let foldApplicationsForTest = 0;
let rebuildApplicationsForTest = 0;

/** Test-only: how many syncs folded buffered deltas vs rebuilt from scratch.
 *  The equivalence property test asserts the fold path actually ran. */
export function transcriptFoldCountersForTest(): {
  readonly folds: number;
  readonly rebuilds: number;
} {
  return {
    folds: foldApplicationsForTest,
    rebuilds: rebuildApplicationsForTest,
  };
}

/** Test-only: drop a stream's fold state so the next sync rebuilds from
 *  scratch — the production resync path, used as the equivalence oracle. */
export function invalidateTranscriptFoldForTest(streamId: StreamTabId): void {
  const fold = streams.get().get(streamId)?.transcriptFold;
  if (fold) resetTranscriptFoldState(fold);
}

/** Test-only: per-stream projection-state occupancy, for eviction-path regression coverage. */
export function streamRenderCacheSizesForTest(): {
  readonly taskGroups: number;
  readonly compaction: number;
  readonly render: number;
} {
  let render = 0;
  for (const slice of streams.get().values()) {
    if (slice.transcriptFold?.hydrated) render += 1;
  }
  return {
    taskGroups: TASK_GROUP_PROJECTIONS.size,
    compaction: COMPACTION_PROJECTIONS.size,
    render,
  };
}

function projectTaskGroupsIncrementally(
  streamId: StreamTabId,
  entries: readonly StreamLogEntry[],
): readonly TaskGroup[] {
  let state = TASK_GROUP_PROJECTIONS.get(streamId);
  if (!state) {
    state = { working: [], index: new Map(), applied: new Map(), snapshot: [] };
    TASK_GROUP_PROJECTIONS.set(streamId, state);
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
  streamId: StreamTabId,
  log: StreamLog,
  streamTerminal: boolean,
): CompactionActivityProjection {
  let state = COMPACTION_PROJECTIONS.get(streamId);
  if (!state || state.appliedHead > log.size) {
    state = {
      projection: createCompactionActivityProjection(),
      appliedHead: 0,
      terminal: false,
    };
    COMPACTION_PROJECTIONS.set(streamId, state);
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

function newFoldChangeFlags(): FoldChangeFlags {
  return {
    itemsChanged: false,
    compactAffected: false,
    syntheticsChanged: false,
    userRescan: false,
    responseRescan: false,
  };
}

function createTranscriptFoldState(): TranscriptFoldState {
  return {
    hydrated: false,
    logInstanceId: 0,
    emissionSeq: 0,
    items: [],
    indexById: new Map(),
    finalizedFrontier: 0,
    latestUserPos: -1,
    latestResponsePos: -1,
    fullLogChild: false,
    workflowOperationalOnly: false,
    projectLifecycleToTaskGroups: false,
    activeSkills: [],
    synthetics: [],
  };
}

function resetTranscriptFoldState(state: TranscriptFoldState): void {
  state.hydrated = false;
  state.logInstanceId = 0;
  state.emissionSeq = 0;
  state.items.length = 0;
  state.indexById.clear();
  state.finalizedFrontier = 0;
  state.latestUserPos = -1;
  state.latestResponsePos = -1;
  state.activeSkillsEntry = undefined;
  state.activeSkillsParsedFor = undefined;
  state.activeSkills = [];
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

interface FoldContext {
  readonly streamId: StreamTabId;
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
 * A tracked singleton row was mutated away from its tracked message type:
 * re-derive both singletons from the full log (rare, producer-anomaly path;
 * keeps the ordinary fold allocation-free).
 */
function retrackFoldSingletons(
  state: TranscriptFoldState,
  log: StreamLog,
): void {
  const entries = log.getRange(0);
  state.activeSkillsEntry = entries.findLast(
    (entry) => entry.messageType === MESSAGE_TYPES.ACTIVE_SKILLS,
  );
  state.liveActivityEntry = entries.findLast((entry) =>
    LIVE_ACTIVITY_MESSAGE_TYPES.has(entry.messageType ?? ''),
  );
}

/** Fold one changed (appended or dirtied) log entry into the items array. */
function applyChangedLogEntry(
  state: TranscriptFoldState,
  entry: StreamLogEntry,
  ctx: FoldContext,
): void {
  const messageType = entry.messageType ?? '';
  const wOO = state.workflowOperationalOnly;
  // Detached child runs surface their full log output (phase group rows and
  // plain log lines, both `DEFAULT`) when focused, unlike the root/subagent
  // transcript which shows only model/tool/user/error rows.
  const transcriptCandidate = (
    state.fullLogChild
      ? CHILD_STREAM_LOG_MESSAGE_TYPES
      : TRANSCRIPT_MESSAGE_TYPES
  ).has(messageType);
  const workflowDefaultLog =
    wOO &&
    entry.type === STREAM_LOG_ENTRY_TYPES.LOG &&
    entry.level !== 'debug' &&
    messageType === MESSAGE_TYPES.DEFAULT;
  const workflowPhaseHeader =
    wOO &&
    messageType === MESSAGE_TYPES.DEFAULT &&
    phaseGroupData(entry) !== null;
  const workflowCall = wOO && messageType === MESSAGE_TYPES.WORKFLOW_TASK;

  const trackedPos = state.indexById.get(entry.id);
  const existingPos =
    trackedPos !== undefined && state.items[trackedPos].rank === 1
      ? trackedPos
      : undefined;

  if (
    !transcriptCandidate &&
    !workflowDefaultLog &&
    !workflowPhaseHeader &&
    !workflowCall
  ) {
    if (existingPos !== undefined)
      removeFoldItemAt(state, existingPos, ctx.flags);
    return;
  }

  const prev =
    existingPos !== undefined
      ? state.items[existingPos].rendered
      : ctx.inherit?.get(entry.id);
  let rendered = renderLogEntryFresh(
    entry,
    prev,
    state.projectLifecycleToTaskGroups,
  );
  // Workflow-agent details are an operational feed, not a model transcript.
  // Detached workflow-script runs intentionally keep their full child log,
  // including Running/Finished and error rows. A phase uses the DEFAULT
  // message type, but remains an operational row.
  if (
    rendered !== null &&
    wOO &&
    !WORKFLOW_OPERATIONAL_ROLES.has(rendered.role) &&
    !workflowDefaultLog
  ) {
    rendered = null;
  }
  if (rendered === null) {
    if (existingPos !== undefined)
      removeFoldItemAt(state, existingPos, ctx.flags);
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
    const id = `compaction:${block.operationId}`;
    const pos = state.indexById.get(id);
    if (pos !== undefined && state.items[pos].block === block) continue;
    const rendered: ConversationEntry = {
      id,
      sourceSeqNo: block.startPosition,
      role: 'activity',
      text: COMPACTION_ACTIVITY_LABEL[block.status],
      messageType: MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY,
      finalized: block.finalized,
      activity: block,
    };
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
    const settled = isSettledEntry(entry, index, items.length);
    if (
      !settled &&
      (entry.role === 'activity' ||
        entry.role === 'workflowTask' ||
        !streamFinal)
    ) {
      break;
    }
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
function applyStreamChanges(
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
    if (entry.messageType === MESSAGE_TYPES.ACTIVE_SKILLS) {
      if (
        !state.activeSkillsEntry ||
        entry.seqNo >= state.activeSkillsEntry.seqNo
      ) {
        state.activeSkillsEntry = entry;
      }
    } else if (state.activeSkillsEntry?.id === entry.id) {
      retrack = true;
    }
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
  if (retrack) retrackFoldSingletons(state, ctx.log);

  const taskGroups = projectTaskGroupsIncrementally(ctx.streamId, changed);
  const compaction = projectCompactionIncrementally(
    ctx.streamId,
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
function compactWorkflowEntries(
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

// ---------------------------------------------------------------------------
// Subscription + sync entry points
// ---------------------------------------------------------------------------

function trySyncStreamLog(streamId: StreamTabId): void {
  try {
    syncStreamLog(streamId);
  } catch (error) {
    setTransientNotice(
      `Could not update transcript: ${toErrorMessage(error)}`,
      { ttlMs: Number.POSITIVE_INFINITY },
    );
  }
}

export function subscribeStreamLog(): () => void {
  const store = defaultSession().transcripts;
  let previousActiveStreamId = activeStreamId.get();

  // One trailing timer shared by every stream: during a multi-subagent burst
  // the root and each child emit within the same window, and per-stream
  // timers would fire staggered — one sync→render pass per stream. A shared
  // batch window coalesces them into a single pass; each stream's buffered
  // delta is folded when it fires, so batching loses nothing.
  const syncDebounce = createFlushableDebounce(() => {
    for (const [streamId, pending] of [...PENDING_DELTAS]) {
      if (pending.generation !== getCliStateGeneration()) {
        PENDING_DELTAS.delete(streamId);
        continue;
      }
      trySyncStreamLog(streamId);
    }
  }, STREAM_SYNC_THROTTLE_MS);

  const dispose = store.onChange((streamId, delta) => {
    if (isCliStreamRetired(streamId)) return;
    const pending = PENDING_DELTAS.get(streamId);
    if (pending) {
      pending.buffer.push(delta);
      pending.generation = getCliStateGeneration();
    } else {
      const buffer = new StreamLogDeltaBuffer(delta.emissionSeq - 1);
      buffer.push(delta);
      PENDING_DELTAS.set(streamId, {
        buffer,
        generation: getCliStateGeneration(),
      });
    }
    // Only start the window on its first tick — later ticks in the same
    // window join the batch without resetting the countdown (`pending`
    // guard), unlike a classic debounce that would restart on every call.
    if (!syncDebounce.pending) syncDebounce.schedule();
  });

  const disposeFocus = subscribeToSignalChanges([activeStreamId], () => {
    const nextActiveStreamId = activeStreamId.get();
    const previous = previousActiveStreamId;
    previousActiveStreamId = nextActiveStreamId;

    if (previous && previous !== nextActiveStreamId) {
      trySyncStreamLog(previous);
    }
    if (!nextActiveStreamId || nextActiveStreamId === previous) return;

    const generation = getCliStateGeneration();
    void store
      .ensureLoaded(nextActiveStreamId)
      .then(() => {
        if (generation === getCliStateGeneration()) {
          trySyncStreamLog(nextActiveStreamId);
        }
      })
      .catch((error: unknown) => {
        if (activeStreamId.get() === nextActiveStreamId) {
          setTransientNotice(
            `Could not load transcript: ${toErrorMessage(error)}`,
            { ttlMs: Number.POSITIVE_INFINITY },
          );
        }
      });
  });

  return () => {
    dispose();
    disposeFocus();
    // Cancel, not flush: the caller is tearing down (process exit or
    // unmount), so a final render of whatever was still pending isn't
    // needed and would race an already-torn-down UI.
    syncDebounce.cancel();
    PENDING_DELTAS.clear();
  };
}

export function syncStreamLog(
  streamId: StreamTabId,
  options: {
    readonly forceFull?: boolean;
    /** Treat the stream as final for settled-prefix promotion, even when its
     *  status has not reached a settlement phase (turn-boundary callers). */
    readonly forceFinal?: boolean;
  } = {},
): void {
  if (isChildStreamRemoved(streamId)) {
    PENDING_DELTAS.delete(streamId);
    TASK_GROUP_PROJECTIONS.delete(streamId);
    COMPACTION_PROJECTIONS.delete(streamId);
    return;
  }
  // AgentTrace throttles MODEL_RESPONSE chunks into the store via a 50ms
  // timer. If we read before that timer fires (e.g. the stream finalized
  // between two TUI sync ticks), the assistant text is still sitting in
  // an in-memory buffer and never reaches the transcript. Force any
  // pending flushers to materialize before we read — their emissions land
  // in this stream's pending buffer and are folded below.
  const session = defaultSession();
  session.flushPendingTraces();
  const store = session.transcripts;
  const log = store.get(streamId);
  const pending = PENDING_DELTAS.get(streamId);
  PENDING_DELTAS.delete(streamId);
  if (!log) {
    // No resident log (never created, or evicted): nothing to fold, but a
    // turn-boundary caller may still promote rows the slice already holds.
    // Fold continuity is gone either way, so drop any hydrated state; the
    // next rebuild inherits promotion from the slice rows.
    if (options.forceFinal === true) {
      patchStream(streamId, (slice) => {
        const entries = finalizeSettledPrefix(slice.entries, true);
        return entries === slice.entries ? slice : { ...slice, entries };
      });
      const fold = streams.get().get(streamId)?.transcriptFold;
      if (fold) resetTranscriptFoldState(fold);
    }
    return;
  }
  const buffer = pending?.buffer;

  const currentActiveStreamId = activeStreamId.get();
  const projectFullTranscript =
    options.forceFull === true ||
    currentActiveStreamId === undefined ||
    currentActiveStreamId === streamId;
  let releaseAfterSync = false;

  patchStream(streamId, (slice, lifecycle) => {
    const workflowStream = slice.category === AgentCategory.Workflow;
    const fullLogChild = isFullLogChildStream(slice);
    const workflowOperationalOnly = workflowStream && !fullLogChild;
    const streamSettled = isTranscriptSettlementPhase(lifecycle.status);
    const streamFinal = options.forceFinal === true || streamSettled;
    const state = slice.transcriptFold ?? createTranscriptFoldState();
    const flags = newFoldChangeFlags();
    const modeCurrent =
      state.fullLogChild === fullLogChild &&
      state.workflowOperationalOnly === workflowOperationalOnly &&
      state.projectLifecycleToTaskGroups === workflowStream;
    // Fold continuity: same log instance, and either the buffered burst picks
    // up exactly where the state left off and reaches the log's emission
    // head, or (no buffer) the state already sits at the head. Anything else
    // — fresh state, gap, reset emission, mode flip — rebuilds from scratch.
    const canFold =
      state.hydrated &&
      modeCurrent &&
      state.logInstanceId === log.instanceId &&
      !log.hasUndrainedChanges &&
      (buffer
        ? !buffer.resyncRequired &&
          buffer.baseEmissionSeq === state.emissionSeq &&
          buffer.emissionSeq === log.emissionHead
        : state.emissionSeq === log.emissionHead);

    const ctx: FoldContext = {
      streamId,
      log,
      sliceEntries: slice.entries,
      streamFinal,
      streamSettled,
      flags,
    };
    let projections;
    if (canFold) {
      foldApplicationsForTest += 1;
      const changes = buffer?.drain();
      const appended = changes?.appended ?? [];
      let dirtied = changes?.dirtied ?? [];
      if (changes && changes.textChunks.length > 0) {
        // The fold applies whole entry values, so resolve each text chunk to
        // its entry's current object. Safe: `canFold` pinned the buffer at
        // the log's emission head, so current values are exactly the
        // post-burst state the chunks stream toward. A chunk's id may also
        // be buffered by (older) value; the resolved current value replaces
        // it in place to keep appended/dirtied disjoint by id.
        const appendedIndexById = new Map(
          appended.map((entry, index) => [entry.id, index] as const),
        );
        const dirtiedById = new Map(
          dirtied.map((entry) => [entry.id, entry] as const),
        );
        for (const chunk of changes.textChunks) {
          const current = log.getById(chunk.id);
          if (!current) continue;
          const appendedIndex = appendedIndexById.get(chunk.id);
          if (appendedIndex !== undefined) {
            appended[appendedIndex] = current;
          } else {
            dirtiedById.set(chunk.id, current);
          }
        }
        dirtied = [...dirtiedById.values()].sort((a, b) => a.seqNo - b.seqNo);
      }
      projections = applyStreamChanges(state, appended, dirtied, ctx);
      state.emissionSeq = log.emissionHead;
    } else {
      rebuildApplicationsForTest += 1;
      const inheritRows = state.hydrated
        ? state.items.map((item) => item.rendered)
        : slice.entries;
      const inherit = new Map<string, ConversationEntry>();
      for (const row of inheritRows) {
        if (!row.synthetic) inherit.set(row.id, row);
      }
      resetTranscriptFoldState(state);
      state.fullLogChild = fullLogChild;
      state.workflowOperationalOnly = workflowOperationalOnly;
      state.projectLifecycleToTaskGroups = workflowStream;
      state.logInstanceId = log.instanceId;
      state.emissionSeq = log.emissionHead;
      state.hydrated = true;
      flags.itemsChanged = true;
      flags.compactAffected = true;
      flags.syntheticsChanged = true;
      projections = applyStreamChanges(state, log.getRange(0), [], {
        ...ctx,
        inherit,
      });
    }

    const { taskGroups, compaction } = projections;
    const compactingActive = compaction.blocks.some(
      (block) => block.status === 'running',
    );
    const live = state.liveActivityEntry;
    const thinkingActive =
      live !== undefined &&
      live.messageType === MESSAGE_TYPES.THINKING &&
      logEntryStreamIsRunning(live);

    let activeSkills = slice.activeSkills;
    if (slice.category === AgentCategory.ToolUse && state.activeSkillsEntry) {
      if (state.activeSkillsParsedFor !== state.activeSkillsEntry) {
        const parsed = ActiveSkillsSnapshotSchema.safeParse(
          state.activeSkillsEntry.data,
        );
        state.activeSkills = parsed.success ? parsed.data.skills : [];
        state.activeSkillsParsedFor = state.activeSkillsEntry;
      }
      activeSkills = state.activeSkills;
    }

    // Transcript-derived live status only. `slice.description` is the
    // runtime's own one-liner and is never written from here.
    const latestUserPos = state.latestUserPos;
    const latestInstruction =
      latestUserPos >= 0 ? state.items[latestUserPos].rendered.text : undefined;
    const latestLine = workflowOperationalOnly
      ? (workflowOperationalLatestLine(state.items) ?? slice.latestLine)
      : ((state.latestResponsePos > latestUserPos
          ? state.items[state.latestResponsePos].rendered.text
          : undefined) ??
        latestInstruction ??
        slice.latestLine);

    releaseAfterSync =
      !projectFullTranscript &&
      lifecycle.status !== undefined &&
      !isActivePhase(lifecycle.status);

    // A compact workflow keeps only its bounded canonical dashboard rows plus
    // synthetic operational rows; ordinary inactive streams keep synthetic
    // rows only. Each selection is rebuilt only when a change touched it —
    // the change detection comes from the delta, not from re-deriving and
    // deep-comparing the whole projection.
    const outputStale =
      state.lastEntriesOutput !== slice.entries ||
      state.lastOutputFull !== projectFullTranscript;
    let entries: readonly ConversationEntry[] = slice.entries;
    if (projectFullTranscript) {
      if (flags.itemsChanged || outputStale) {
        entries = state.items.map((item) => item.rendered);
      }
    } else if (workflowStream) {
      if (flags.compactAffected || outputStale) {
        entries = compactWorkflowEntries(state.items);
      }
    } else if (flags.syntheticsChanged || outputStale) {
      entries = state.synthetics;
    }
    state.lastOutputFull = projectFullTranscript;
    state.lastEntriesOutput = entries;

    if (
      slice.transcriptFold === state &&
      entries === slice.entries &&
      slice.latestLine === latestLine &&
      slice.thinkingActive === thinkingActive &&
      slice.compactingActive === compactingActive &&
      isDeepStrictEqual(slice.activeSkills, activeSkills) &&
      slice.taskGroups === taskGroups
    ) {
      return slice;
    }
    return {
      ...slice,
      transcriptFold: state,
      latestLine,
      entries,
      activeSkills,
      thinkingActive,
      compactingActive,
      taskGroups,
    };
  });

  if (releaseAfterSync) {
    store.requestEviction(streamId);
    // The store dropped its resident log; these incremental caches would
    // otherwise keep every entry (and rendered row) of a completed stream
    // alive for the rest of the session. Safe to drop: each projection
    // rebuilds from scratch — through the shared resync path — the next
    // time this stream syncs (e.g. if it's reactivated).
    TASK_GROUP_PROJECTIONS.delete(streamId);
    COMPACTION_PROJECTIONS.delete(streamId);
    const fold = streams.get().get(streamId)?.transcriptFold;
    if (fold) resetTranscriptFoldState(fold);
  }

  // Surface stream as active if we don't already have one — handles bare
  // `texra chat` where setActiveStream is the first signal the runtime emits.
  focusStream(streamId, { onlyIfUnset: true });
}
