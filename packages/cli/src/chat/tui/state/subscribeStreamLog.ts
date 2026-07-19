// Mirror StreamLogStore user/model/tool entries into
// `streams[].entries` (state/cliState.ts). Approval/permission
// entries land in side panels and modals; tool rows render inline alongside
// assistant prose.

import { isDeepStrictEqual } from 'node:util';

import { defaultSession } from '@agent/runtime/SessionHandle';
import { appendCliApiSwitchHint } from '@cli/runtime/approvalAdapter';
import {
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  TOOL_USE_STATUS,
  type NormalizedToolUse,
  type StreamLogEntry,
  type StreamTabId,
} from '@shared/schemas';
import { normalizeToolUseData } from '@shared/toolUse';

import {
  hasIncompleteEmbeddedSubagentFollowup,
  summarizeFollowupMessage,
} from '@shared/subagentFollowup';
import { flushPendingRunTraces } from '@transcript';
import { createFlushableDebounce } from '@utils/core';
import { normalizeKnownHtmlForCliMarkdown } from '../render/htmlMarkdownNormalize';
import {
  isRenderableTranscriptEntry,
  trimAssistantTranscriptLead,
} from '../panes/transcriptEntries';
import {
  activeStreamId,
  getCliStateGeneration,
  isCliStreamRetired,
  patchStream,
  type ConversationEntry,
} from './cliState';
import { isChildStreamRemoved } from './childExecutions';
import { isFinalTranscriptStatus } from './transcript';

const TRANSCRIPT_MESSAGE_TYPES = new Set<string>([
  MESSAGE_TYPES.ERROR,
  MESSAGE_TYPES.MODEL_RESPONSE,
  MESSAGE_TYPES.TOOL_USE,
  MESSAGE_TYPES.USER_MESSAGE,
]);

const CHILD_STREAM_LOG_MESSAGE_TYPES = new Set<string>([
  ...TRANSCRIPT_MESSAGE_TYPES,
  MESSAGE_TYPES.DEFAULT,
]);

const LIVE_ACTIVITY_MESSAGE_TYPES = new Set<string>([
  MESSAGE_TYPES.THINKING,
  MESSAGE_TYPES.MODEL_RESPONSE,
  MESSAGE_TYPES.TOOL_USE,
  MESSAGE_TYPES.ERROR,
  MESSAGE_TYPES.USER_MESSAGE,
]);

function transcriptMessageTypesForStream(streamId: StreamTabId): Set<string> {
  // Detached child runs surface their full log output (phase group rows and
  // plain log lines, both `DEFAULT`) when focused, unlike the root/subagent
  // transcript which shows only model/tool/user/error rows. A workflow-script
  // run is one such child: its phases and per-agent Running/Finished lines
  // project onto its own stream trace and must render in its focused viewport.
  return /^(bash@tool|claude@agent-sdk|codex@codex-sdk|workflow-script)#/.test(
    streamId,
  )
    ? CHILD_STREAM_LOG_MESSAGE_TYPES
    : TRANSCRIPT_MESSAGE_TYPES;
}

function logEntryHasText(entry: StreamLogEntry): boolean {
  return (entry.text ?? '').trim().length > 0;
}

function logEntryStreamIsRunning(entry: StreamLogEntry): boolean {
  const data = entry.data;
  if (typeof data !== 'object' || data === null || !('status' in data)) {
    return logEntryHasText(entry);
  }
  return data.status === 'running';
}

function latestLogActivityIsThinking(
  entries: readonly StreamLogEntry[],
): boolean {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || !LIVE_ACTIVITY_MESSAGE_TYPES.has(entry.messageType ?? '')) {
      continue;
    }
    return (
      entry.messageType === MESSAGE_TYPES.THINKING &&
      logEntryStreamIsRunning(entry)
    );
  }
  return false;
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
    prev.messageType !== next.messageType ||
    prev.pendingEmbeddedSubagentFollowup !==
      next.pendingEmbeddedSubagentFollowup ||
    prev.finalized !== next.finalized
  ) {
    return false;
  }
  if (prev.role === 'tool' && next.role === 'tool') {
    return toolUseEqual(prev.toolUse, next.toolUse);
  }
  if (prev.role === 'process' && next.role === 'process') {
    return prev.process === next.process;
  }
  if (prev.role === 'phase' && next.role === 'phase') {
    return (
      prev.phaseIndex === next.phaseIndex && prev.phaseTotal === next.phaseTotal
    );
  }
  return true;
}

/**
 * A phase group header — the `stage.start`/`stage.end` rows a workflow-script
 * run emits per `phase()` (recorded as GROUP_START then upserted in place to
 * GROUP_END with `data.kind === 'phase'`). Detected by `kind`, not entry
 * `type`, so the header keeps its distinct role after the phase closes. Round,
 * run, and session groups (other `kind` values) fall through to plain rows.
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
  const data = entry.data;
  if (typeof data !== 'object' || data === null || !('kind' in data)) {
    return null;
  }
  const { kind, index, total } = data as {
    kind?: unknown;
    index?: unknown;
    total?: unknown;
  };
  if (kind !== 'phase') return null;
  return {
    ...(typeof index === 'number' ? { index } : {}),
    ...(typeof total === 'number' ? { total } : {}),
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
): string {
  switch (role) {
    case 'assistant':
      return normalizeKnownHtmlForCliMarkdown(
        trimAssistantTranscriptLead(text),
      );
    case 'error':
      return appendCliApiSwitchHint(text);
    case 'user':
      return summarizeFollowupMessage(text);
  }
}

function renderLogEntry(
  entry: StreamLogEntry,
  prev: ConversationEntry | undefined,
): ConversationEntry | null {
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
      id: entry.id,
      role: 'tool',
      text: '',
      ...(entry.messageType ? { messageType: entry.messageType } : {}),
      finalized: prev?.finalized ?? false,
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

  // Phase group headers finalize the moment they appear (like user/error
  // rows): the label never changes, and a later stage.end only upserts the
  // group's `data`, keeping the same id. Detect before the generic text path
  // so the row renders as a distinct divider instead of plain assistant prose.
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
      id: entry.id,
      role: 'phase',
      text: phaseLabel,
      ...(entry.messageType ? { messageType: entry.messageType } : {}),
      finalized: true,
      phaseLabel,
      ...(phaseIndex !== undefined ? { phaseIndex } : {}),
      ...(phaseTotal !== undefined ? { phaseTotal } : {}),
    };
    return prev && entriesEqual(prev, next) ? prev : next;
  }

  const text = entry.text ?? '';
  const role = logEntryRole(entry.messageType);
  const assistantTranscript =
    role === 'assistant' ? trimAssistantTranscriptLead(text) : undefined;
  const renderedText = renderLogEntryText(role, text);
  // Assistant text is promoted by `finalizeSettledPrefix` once the model
  // moves on to a later entry; inherit the prior flag here so a re-sync
  // can't de-finalize an already-promoted block. User/error rows can't
  // change after they appear, so they finalize immediately.
  const finalized = role === 'assistant' ? (prev?.finalized ?? false) : true;
  const next: ConversationEntry = {
    id: entry.id,
    role,
    text: renderedText,
    ...(entry.messageType ? { messageType: entry.messageType } : {}),
    ...(assistantTranscript !== undefined &&
    hasIncompleteEmbeddedSubagentFollowup(assistantTranscript)
      ? { pendingEmbeddedSubagentFollowup: true }
      : {}),
    finalized,
  };
  if (!isRenderableTranscriptEntry(next)) return null;
  return prev && entriesEqual(prev, next) ? prev : next;
}

// An entry is "settled" once its content can no longer change, so it is
// safe to print once into `<Static>` scrollback:
//   - user / error / process: fixed the moment they appear.
//   - assistant: frozen once the model emits a later entry (more text or a
//     tool call). The trailing block may still be streaming.
//   - tool: frozen once its result lands (status COMPLETED).
function isSettledEntry(
  entry: ConversationEntry,
  index: number,
  entries: readonly ConversationEntry[],
): boolean {
  switch (entry.role) {
    case 'user':
    case 'error':
    case 'process':
    case 'phase':
      return true;
    case 'tool':
      return (
        entry.toolUse.status === TOOL_USE_STATUS.COMPLETED ||
        entry.toolUse.status === TOOL_USE_STATUS.FAILED
      );
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
// would reverse. When the stream reaches a final status every remaining
// entry settles, including the trailing live block.
export function finalizeSettledPrefix(
  entries: readonly ConversationEntry[],
  streamFinal: boolean,
): ConversationEntry[] {
  let result: ConversationEntry[] | undefined;
  let sealed = false; // hit the first still-pending entry in this round
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.finalized) continue;
    if (!streamFinal && (sealed || !isSettledEntry(entry, index, entries))) {
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

export function subscribeStreamLog(): () => void {
  const store = defaultSession().transcripts;
  const pendingStreams = new Map<StreamTabId, number>();

  // One trailing timer shared by every stream: during a multi-subagent burst
  // the root and each child emit within the same window, and per-stream
  // timers would fire staggered — one sync→render pass per stream. A shared
  // batch window coalesces them into a single pass; syncStreamLog reads the
  // full log when it fires, so batching loses nothing.
  const syncDebounce = createFlushableDebounce(() => {
    const streamIds = [...pendingStreams];
    pendingStreams.clear();
    for (const [id, generation] of streamIds) {
      if (generation === getCliStateGeneration()) syncStreamLog(id);
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

  return () => {
    dispose();
    // Cancel, not flush: the caller is tearing down (process exit or
    // unmount), so a final render of whatever was still pending isn't
    // needed and would race an already-torn-down UI.
    syncDebounce.cancel();
    pendingStreams.clear();
  };
}

export function syncStreamLog(streamId: StreamTabId): void {
  if (isChildStreamRemoved(streamId)) return;
  // AgentTrace throttles MODEL_RESPONSE chunks into the store via a 50ms
  // timer. If we read before that timer fires (e.g. the stream finalized
  // between two TUI sync ticks), the assistant text is still sitting in
  // an in-memory buffer and never reaches the transcript. Force any
  // pending flushers to materialize before we read.
  flushPendingRunTraces();
  const store = defaultSession().transcripts;
  const log = store.get(streamId);
  if (!log) return;

  const allEntries = log.getRange(0);
  const thinkingActive = latestLogActivityIsThinking(allEntries);
  const transcriptMessageTypes = transcriptMessageTypesForStream(streamId);
  const responses = allEntries.filter((entry: StreamLogEntry) =>
    transcriptMessageTypes.has(entry.messageType ?? ''),
  );

  patchStream(streamId, (slice) => {
    const existing = new Map(slice.entries.map((e) => [e.id, e]));
    const syntheticEntries = slice.entries.filter((entry) => entry.synthetic);
    const streamFinal = isFinalTranscriptStatus(slice.status);
    const logCandidates: TranscriptCandidate[] = [];
    for (const entry of responses) {
      const rendered = renderLogEntry(entry, existing.get(entry.id));
      if (!rendered) continue;
      logCandidates.push({ rendered, sortSeq: entry.seqNo, tieBreak: 0 });
    }
    // Synthetic (local/process) rows are positioned by `syntheticAfterSeq`
    // alongside the ordered log entries; push into a copy so we don't mutate
    // `logCandidates` itself.
    const candidates: TranscriptCandidate[] =
      syntheticEntries.length === 0 ? logCandidates : [...logCandidates];

    for (const [index, entry] of syntheticEntries.entries()) {
      candidates.push({
        rendered: entry,
        sortSeq: entry.syntheticAfterSeq ?? Number.POSITIVE_INFINITY,
        tieBreak: index + 1,
      });
    }

    const ordered = sortTranscriptCandidatesIfNeeded(candidates).map(
      (candidate) => candidate.rendered,
    );
    // Promote the settled prefix only after sorting: "is there a later
    // entry" and Static append order are both defined on the final stream
    // order, not the per-entry render order.
    const next = finalizeSettledPrefix(ordered, streamFinal);

    const changed =
      slice.entries.length !== next.length ||
      slice.entries.some((entry, index) => {
        const candidate = next[index];
        return (
          !candidate ||
          entry.id !== candidate.id ||
          !entriesEqual(entry, candidate)
        );
      });
    if (!changed && slice.thinkingActive === thinkingActive) return slice;
    return { ...slice, entries: next, thinkingActive };
  });

  // Surface stream as active if we don't already have one — handles bare
  // `texra chat` where setActiveStream is the first signal the runtime emits.
  if (!activeStreamId.get()) {
    activeStreamId.set(streamId);
  }
}
