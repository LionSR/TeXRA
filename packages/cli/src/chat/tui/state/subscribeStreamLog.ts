// Mirror StreamLogStore user/model/tool entries into
// `streams[].entries` (state/cliState.ts). Approval/permission
// entries land in side panels and modals; tool rows render inline alongside
// assistant prose.
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
  type NormalizedToolUse,
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
  entries: readonly ConversationEntry[],
): string | undefined {
  for (const entry of entries.toReversed()) {
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

function transcriptMessageTypesForStream(
  slice: Pick<StreamSlice, 'identity'> | undefined,
): Set<string> {
  // Detached child runs surface their full log output (phase group rows and
  // plain log lines, both `DEFAULT`) when focused, unlike the root/subagent
  // transcript which shows only model/tool/user/error rows. A workflow-script
  // run is one such child: its phases and per-agent Running/Finished lines
  // project onto its own stream trace and must render in its focused viewport.
  return isFullLogChildStream(slice)
    ? CHILD_STREAM_LOG_MESSAGE_TYPES
    : TRANSCRIPT_MESSAGE_TYPES;
}

function logEntryStreamIsRunning(entry: StreamLogEntry): boolean {
  const data = entry.data;
  if (typeof data !== 'object' || data === null || !('status' in data)) {
    return (entry.text ?? '').trim().length > 0;
  }
  return data.status === 'running';
}

function latestLogActivityIsThinking(
  entries: readonly StreamLogEntry[],
): boolean {
  const entry = entries.findLast((candidate) =>
    LIVE_ACTIVITY_MESSAGE_TYPES.has(candidate.messageType ?? ''),
  );
  if (!entry) return false;
  return (
    entry.messageType === MESSAGE_TYPES.THINKING &&
    logEntryStreamIsRunning(entry)
  );
}

/** Tool inputs are typed `unknown` (model-supplied JSON) and reach us
 *  via Zod passthrough, so a `===` compare would defeat the cache the
 *  moment any upstream code reconstructs `data` (deserialization,
 *  structured clone, future log replay). Inputs are small — tool call
 *  args, not output — so a structural comparison is cheap. */
function inputEqual(prev: unknown, next: unknown): boolean {
  return prev === next || isDeepStrictEqual(prev, next);
}

// Field-by-field — a stringified signature over the whole NormalizedToolUse
// would allocate the full outputText (potentially 50 KB+ of bash output) on
// every comparison. Cover every field ToolUseRow reads so future changes
// can't be silently swallowed.
function toolUseEqual(
  prev: NormalizedToolUse,
  next: NormalizedToolUse,
): boolean {
  return (
    prev.status === next.status &&
    prev.toolName === next.toolName &&
    prev.outputText === next.outputText &&
    prev.errorText === next.errorText &&
    prev.exitCode === next.exitCode &&
    prev.headerSummary === next.headerSummary &&
    prev.isError === next.isError &&
    prev.isUserFeedback === next.isUserFeedback &&
    prev.userInstructionText === next.userInstructionText &&
    inputEqual(prev.input, next.input)
  );
}

// `normalizeToolUseData` is dominated by a Zod parse + YAML stringify
// of `entry.data`. `StreamLog.update` spreads its patch into a fresh
// `data` object every tick, so reference equality is a reliable signal
// that nothing has actually changed. Keep the last-seen `data` ref off
// to the side in a WeakMap rather than on `ConversationEntry` itself —
// stashing it on the entry would mean either (a) the slice-level
// `entriesEqual` check ignores `toolUseSource` and the cache refresh
// never persists, or (b) we trigger a slice update on every tick just
// to write the new reference. The WeakMap dodges both: the entry stays
// immutable, and the cache is GC'd when the entry is replaced.
const toolUseSourceCache = new WeakMap<ConversationEntry, unknown>();

function entriesEqual(
  prev: ConversationEntry,
  next: ConversationEntry,
): boolean {
  if (
    prev.role !== next.role ||
    prev.text !== next.text ||
    prev.sourceSeqNo !== next.sourceSeqNo ||
    prev.messageType !== next.messageType ||
    prev.pendingEmbeddedSubagentFollowup !==
      next.pendingEmbeddedSubagentFollowup ||
    prev.finalized !== next.finalized ||
    prev.settlementSeqNo !== next.settlementSeqNo
  ) {
    return false;
  }
  if (prev.role === 'tool' && next.role === 'tool') {
    return toolUseEqual(prev.toolUse, next.toolUse);
  }
  if (prev.role === 'media' && next.role === 'media') {
    return isDeepStrictEqual(prev.images, next.images);
  }
  if (prev.role === 'phase' && next.role === 'phase') {
    return (
      prev.phaseIndex === next.phaseIndex && prev.phaseTotal === next.phaseTotal
    );
  }
  if (prev.role === 'workflowTask' && next.role === 'workflowTask') {
    return isDeepStrictEqual(prev.task, next.task);
  }
  return true;
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
  role: 'assistant' | 'error' | 'user',
  text: string,
  data: unknown,
): string {
  switch (role) {
    case 'assistant':
      return normalizeKnownHtmlForCliMarkdown(
        trimAssistantTranscriptLead(text),
      );
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
 * Once an entry settles, or (for the given kind) always finalizes, it stays
 * finalized: a re-sync tick can never roll an already-promoted entry back.
 */
function computeFinalized(
  entry: StreamLogEntry,
  prev: ConversationEntry | undefined,
  alwaysFinalized = false,
): boolean {
  return (
    entry.settlementSeqNo !== undefined ||
    alwaysFinalized ||
    (prev?.finalized ?? false)
  );
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

/** Reuses `prev` when `next` is content-equal, so an unchanged row keeps identity. */
function dedupeEntry(
  prev: ConversationEntry | undefined,
  next: ConversationEntry,
): ConversationEntry {
  return prev && entriesEqual(prev, next) ? prev : next;
}

function renderLogEntry(
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
    return dedupeEntry(prev, next);
  }

  if (entry.messageType === MESSAGE_TYPES.TOOL_USE) {
    // Cache hit: same `data` reference as last sync, no re-normalize.
    // Promotion to `<Static>` is decided later by `finalizeSettledPrefix`
    // over the ordered slice, so a cache hit just returns `prev` as-is.
    if (prev?.role === 'tool' && toolUseSourceCache.get(prev) === entry.data) {
      return prev;
    }

    const toolUse = normalizeToolUseData(entry.data);
    // Drop malformed tool entries rather than crash. The progress view
    // does the same — a bad payload shouldn't take down the transcript.
    if (!toolUse) return null;
    // Never finalize here. `finalizeSettledPrefix` promotes a tool row only
    // once it completes AND every entry before it has promoted, so a
    // fast tool can't jump ahead of still-streaming assistant text in
    // `<Static>` (which is append-only). Inherit the prior flag so a sync
    // tick can't roll an already-promoted entry back to false.
    const next: ConversationEntry = {
      ...baseLogEntryFields(entry, 'tool', ''),
      finalized: computeFinalized(entry, prev),
      toolUse,
    };
    if (prev && entriesEqual(prev, next)) {
      // Same content under a fresh `data` reference: refresh the cache
      // key on `prev` so the identity fast path hits on the next tick.
      // Returning `prev` keeps the slice unchanged (no re-render
      // cascade) — the cache lives outside the entry contract so this
      // refresh doesn't need a slice update to persist.
      toolUseSourceCache.set(prev, entry.data);
      return prev;
    }
    toolUseSourceCache.set(next, entry.data);
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
      finalized: computeFinalized(entry, prev),
      task: call,
    };
    return dedupeEntry(prev, next);
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
    return dedupeEntry(prev, next);
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
  const assistantTranscript =
    role === 'assistant' ? trimAssistantTranscriptLead(text) : undefined;
  let renderedText = renderLogEntryText(role, text, entry.data);
  if (
    role === 'assistant' &&
    entry.messageType === MESSAGE_TYPES.DEFAULT &&
    entry.type === STREAM_LOG_ENTRY_TYPES.LOG
  ) {
    renderedText = redactSecrets(safeTerminalText(renderedText));
  }
  // Assistant text is promoted by `finalizeSettledPrefix` once the model
  // moves on to a later entry; inherit the prior flag here so a re-sync
  // can't de-finalize an already-promoted block. User/error rows can't
  // change after they appear, so they finalize immediately.
  const finalized = computeFinalized(entry, prev, role !== 'assistant');
  const next: ConversationEntry = {
    ...baseLogEntryFields(entry, role, renderedText),
    ...(assistantTranscript !== undefined &&
    hasIncompleteEmbeddedSubagentFollowup(assistantTranscript)
      ? { pendingEmbeddedSubagentFollowup: true }
      : {}),
    finalized,
  };
  if (!isRenderableTranscriptEntry(next)) return null;
  return dedupeEntry(prev, next);
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
  entries: readonly ConversationEntry[],
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
      return (
        !entry.pendingEmbeddedSubagentFollowup && index < entries.length - 1
      );
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
    const settled = isSettledEntry(entry, index, entries);
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
    const promoted: ConversationEntry = { ...entry, finalized: true };
    // Carry the WeakMap cache key onto the clone so the tool fast-path in
    // `renderLogEntry` keeps hitting after promotion.
    if (entry.role === 'tool') {
      const cached = toolUseSourceCache.get(entry);
      if (cached !== undefined) toolUseSourceCache.set(promoted, cached);
    }
    result[index] = promoted;
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

type TranscriptCandidate = {
  readonly rendered: ConversationEntry;
  readonly sortSeq: number;
  readonly tieBreak: number;
};

function compareTranscriptCandidates(
  left: TranscriptCandidate,
  right: TranscriptCandidate,
): number {
  return left.sortSeq - right.sortSeq || left.tieBreak - right.tieBreak;
}

// Log entries already arrive in seqNo order, so the per-tick common case is
// fully sorted — only synthetic rows (spliced in by syntheticAfterSeq) can
// land out of order. Detect sortedness in O(N) instead of paying the sort's
// comparator churn on every streaming delta.
function sortTranscriptCandidatesIfNeeded(
  candidates: TranscriptCandidate[],
): TranscriptCandidate[] {
  for (let index = 1; index < candidates.length; index += 1) {
    if (
      compareTranscriptCandidates(candidates[index - 1], candidates[index]) > 0
    ) {
      return candidates.sort(compareTranscriptCandidates);
    }
  }
  return candidates;
}

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
registerCliStateResetHook(() => {
  TASK_GROUP_PROJECTIONS.clear();
  COMPACTION_PROJECTIONS.clear();
});

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
  entries: readonly StreamLogEntry[],
  streamTerminal: boolean,
): CompactionActivityProjection {
  let state = COMPACTION_PROJECTIONS.get(streamId);
  if (!state || state.appliedHead > entries.length) {
    state = {
      projection: createCompactionActivityProjection(),
      appliedHead: 0,
      terminal: false,
    };
    COMPACTION_PROJECTIONS.set(streamId, state);
  }

  applyCompactionActivityEntries(
    state.projection,
    entries.slice(state.appliedHead),
  );
  state.appliedHead = entries.length;
  if (streamTerminal && !state.terminal) {
    settleCompactionActivities(state.projection, {
      throughSeqNo: entries.length,
    });
  }
  state.terminal = streamTerminal;
  return state.projection;
}

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
  const pendingStreams = new Map<StreamTabId, number>();
  let previousActiveStreamId = activeStreamId.get();

  // One trailing timer shared by every stream: during a multi-subagent burst
  // the root and each child emit within the same window, and per-stream
  // timers would fire staggered — one sync→render pass per stream. A shared
  // batch window coalesces them into a single pass; syncStreamLog reads the
  // full log when it fires, so batching loses nothing.
  const syncDebounce = createFlushableDebounce(() => {
    const streamIds = [...pendingStreams];
    pendingStreams.clear();
    for (const [id, generation] of streamIds) {
      if (generation !== getCliStateGeneration()) continue;
      trySyncStreamLog(id);
    }
  }, STREAM_SYNC_THROTTLE_MS);

  const dispose = store.onChange((streamId) => {
    if (isCliStreamRetired(streamId)) return;
    pendingStreams.set(streamId, getCliStateGeneration());
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
    pendingStreams.clear();
  };
}

export function syncStreamLog(
  streamId: StreamTabId,
  options: { readonly forceFull?: boolean } = {},
): void {
  if (isChildStreamRemoved(streamId)) {
    TASK_GROUP_PROJECTIONS.delete(streamId);
    COMPACTION_PROJECTIONS.delete(streamId);
    return;
  }
  // AgentTrace throttles MODEL_RESPONSE chunks into the store via a 50ms
  // timer. If we read before that timer fires (e.g. the stream finalized
  // between two TUI sync ticks), the assistant text is still sitting in
  // an in-memory buffer and never reaches the transcript. Force any
  // pending flushers to materialize before we read.
  const session = defaultSession();
  session.flushPendingTraces();
  const store = session.transcripts;
  const log = store.get(streamId);
  if (!log) return;

  const allEntries = log.getRange(0);
  const activeSkillsEntry = allEntries.findLast(
    (entry) => entry.messageType === MESSAGE_TYPES.ACTIVE_SKILLS,
  );
  const parsedActiveSkills = activeSkillsEntry
    ? ActiveSkillsSnapshotSchema.safeParse(activeSkillsEntry.data)
    : undefined;
  const taskGroups = projectTaskGroupsIncrementally(streamId, allEntries);
  const thinkingActive = latestLogActivityIsThinking(allEntries);
  const transcriptMessageTypes = transcriptMessageTypesForStream(
    streams.get().get(streamId),
  );
  const currentActiveStreamId = activeStreamId.get();
  const projectFullTranscript =
    options.forceFull === true ||
    currentActiveStreamId === undefined ||
    currentActiveStreamId === streamId;
  let releaseAfterSync = false;

  patchStream(streamId, (slice, lifecycle) => {
    const existing = new Map(slice.entries.map((e) => [e.id, e]));
    const workflowStream = slice.category === AgentCategory.Workflow;
    let activeSkills = slice.activeSkills;
    if (slice.category === AgentCategory.ToolUse && parsedActiveSkills) {
      activeSkills = parsedActiveSkills.success
        ? parsedActiveSkills.data.skills
        : [];
    }
    const workflowOperationalOnly =
      workflowStream && !isFullLogChildStream(slice);
    const syntheticEntries = slice.entries.filter(
      (entry) =>
        entry.synthetic &&
        (!workflowOperationalOnly ||
          WORKFLOW_OPERATIONAL_ROLES.has(entry.role)),
    );
    const streamFinal = isTranscriptSettlementPhase(lifecycle.status);
    const compactionProjection = projectCompactionIncrementally(
      streamId,
      allEntries,
      streamFinal,
    );
    const compactingActive = compactionProjection.blocks.some(
      (block) => block.status === 'running',
    );
    const logCandidates: TranscriptCandidate[] = [];
    const workflowLatestLineCandidates: TranscriptCandidate[] = [];
    for (const block of compactionProjection.blocks) {
      const id = `compaction:${block.operationId}`;
      const next: ConversationEntry = {
        id,
        sourceSeqNo: block.startPosition,
        role: 'activity',
        text: COMPACTION_ACTIVITY_LABEL[block.status],
        messageType: MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY,
        finalized: block.finalized,
        activity: block,
      };
      logCandidates.push({
        rendered: dedupeEntry(existing.get(id), next),
        sortSeq: block.startPosition,
        tieBreak: 0,
      });
    }
    for (const entry of allEntries) {
      const messageType = entry.messageType ?? '';
      const transcriptCandidate = transcriptMessageTypes.has(messageType);
      const workflowDefaultLog =
        workflowOperationalOnly &&
        entry.type === STREAM_LOG_ENTRY_TYPES.LOG &&
        entry.level !== 'debug' &&
        messageType === MESSAGE_TYPES.DEFAULT;
      const workflowPhaseHeader =
        workflowOperationalOnly &&
        messageType === MESSAGE_TYPES.DEFAULT &&
        phaseGroupData(entry) !== null;
      const workflowCall =
        workflowOperationalOnly && messageType === MESSAGE_TYPES.WORKFLOW_TASK;
      if (
        !transcriptCandidate &&
        !workflowDefaultLog &&
        !workflowPhaseHeader &&
        !workflowCall
      ) {
        continue;
      }
      const rendered = renderLogEntry(
        entry,
        existing.get(entry.id),
        slice.category === AgentCategory.Workflow,
      );
      if (!rendered) continue;
      if (workflowOperationalOnly) {
        workflowLatestLineCandidates.push({
          rendered,
          sortSeq: entry.seqNo,
          tieBreak: 0,
        });
      }
      // Workflow-agent details are an operational feed, not a model
      // transcript. Detached workflow-script runs intentionally keep their
      // full child log, including Running/Finished and error rows. A phase
      // uses the DEFAULT message type, but remains an operational row.
      if (
        workflowOperationalOnly &&
        !WORKFLOW_OPERATIONAL_ROLES.has(rendered.role) &&
        !workflowDefaultLog
      ) {
        continue;
      }
      logCandidates.push({ rendered, sortSeq: entry.seqNo, tieBreak: 0 });
    }
    // Synthetic (CLI-owned) rows are positioned by `syntheticAfterSeq`
    // alongside the ordered log entries; push into a copy so we don't mutate
    // `logCandidates` itself.
    const candidates: TranscriptCandidate[] =
      syntheticEntries.length === 0 ? logCandidates : [...logCandidates];

    for (const [index, entry] of syntheticEntries.entries()) {
      const candidate = {
        rendered: entry,
        sortSeq: entry.syntheticAfterSeq ?? Number.POSITIVE_INFINITY,
        tieBreak: index + 1,
      };
      candidates.push(candidate);
      if (workflowOperationalOnly) {
        workflowLatestLineCandidates.push(candidate);
      }
    }

    const ordered = sortTranscriptCandidatesIfNeeded(candidates).map(
      (candidate) => candidate.rendered,
    );
    // Promote the settled prefix only after sorting: "is there a later
    // entry" and Static append order are both defined on the final stream
    // order, not the per-entry render order.
    const next = finalizeSettledPrefix(ordered, streamFinal);
    const latestUserIndex = next.findLastIndex(
      (entry) => entry.role === 'user' && entry.text.trim(),
    );
    const latestInstruction =
      latestUserIndex >= 0 ? next[latestUserIndex]?.text : undefined;
    // Transcript-derived live status only. `slice.description` is the
    // runtime's own one-liner and is never written from here.
    const latestLine = workflowOperationalOnly
      ? (workflowOperationalLatestLine(
          sortTranscriptCandidatesIfNeeded(workflowLatestLineCandidates).map(
            (candidate) => candidate.rendered,
          ),
        ) ?? slice.latestLine)
      : (next.findLast(
          (entry, index) =>
            index > latestUserIndex &&
            entry.role === 'assistant' &&
            entry.messageType === MESSAGE_TYPES.MODEL_RESPONSE &&
            entry.finalized &&
            entry.text.trim(),
        )?.text ??
        latestInstruction ??
        slice.latestLine);
    releaseAfterSync =
      !projectFullTranscript &&
      lifecycle.status !== undefined &&
      !isActivePhase(lifecycle.status);

    // A compact workflow keeps only its bounded canonical dashboard rows plus
    // synthetic operational rows. Ordinary inactive streams retain the prior
    // synthetic-only behavior.
    const compactWorkflowDashboardIds = new Set(
      next
        .filter((entry) => WORKFLOW_DASHBOARD_ROLES.has(entry.role))
        .slice(-MAX_COMPACT_WORKFLOW_DASHBOARD_ENTRIES)
        .map((entry) => entry.id),
    );
    const compactEntries = workflowStream
      ? next.filter(
          (entry) =>
            entry.synthetic || compactWorkflowDashboardIds.has(entry.id),
        )
      : syntheticEntries;
    const nextEntries = projectFullTranscript ? next : compactEntries;
    const entriesUnchanged =
      slice.entries.length === nextEntries.length &&
      slice.entries.every((entry, index) => {
        const candidate = nextEntries[index];
        return projectFullTranscript
          ? entry.id === candidate.id && entriesEqual(entry, candidate)
          : entry === candidate;
      });
    if (
      entriesUnchanged &&
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
      latestLine,
      entries: nextEntries,
      activeSkills,
      thinkingActive,
      compactingActive,
      taskGroups,
    };
  });

  if (releaseAfterSync) store.requestEviction(streamId);

  // Surface stream as active if we don't already have one — handles bare
  // `texra chat` where setActiveStream is the first signal the runtime emits.
  focusStream(streamId, { onlyIfUnset: true });
}
