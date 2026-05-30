// Mirror StreamLogStore user/model/tool entries into
// `cliState.streams[].entries`. Approval/permission entries land in side
// panels and modals; tool rows render inline alongside assistant prose.

import { flushPendingRunTraces, getDefaultStreamLogStore } from '@transcript';
import { appendCliApiSwitchHint } from '@cli/runtime/approvalAdapter';
import {
  MESSAGE_TYPES,
  TOOL_USE_STATUS,
  type NormalizedToolUse,
  type StreamLogEntry,
  type StreamTabId,
} from '@shared/schemas';
import { normalizeToolUseData } from '@shared/toolUse';

import { summarizeSubagentFollowup } from '@shared/subagentFollowup';
import { cliState, patchStream, type ConversationEntry } from './cliState';
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

function transcriptMessageTypesForStream(streamId: StreamTabId): Set<string> {
  return /^(bash@tool|claude@agent-sdk|codex@codex-sdk)#/.test(streamId)
    ? CHILD_STREAM_LOG_MESSAGE_TYPES
    : TRANSCRIPT_MESSAGE_TYPES;
}

/** Tool inputs are typed `unknown` (model-supplied JSON) and reach us
 *  via Zod passthrough, so a `===` compare would defeat the cache the
 *  moment any upstream code reconstructs `data` (deserialization,
 *  structured clone, future log replay). Inputs are small — tool call
 *  args, not output — so a JSON serialization is cheap. */
function inputEqual(prev: unknown, next: unknown): boolean {
  if (prev === next) return true;
  try {
    return JSON.stringify(prev) === JSON.stringify(next);
  } catch {
    return false;
  }
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

export function stripOrchestratorFollowup(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(
    /^<orchestrator-followup>\s*([\s\S]*?)\s*<\/orchestrator-followup>$/,
  );
  return match?.[1]?.trim() ?? text;
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
    prev.finalized !== next.finalized
  ) {
    return false;
  }
  if (prev.role === 'tool') {
    if (!prev.toolUse || !next.toolUse) return prev.toolUse === next.toolUse;
    return toolUseEqual(prev.toolUse, next.toolUse);
  }
  if (prev.role === 'process') {
    return prev.process === next.process;
  }
  return true;
}

function logEntryRole(
  messageType: string | undefined,
): ConversationEntry['role'] {
  if (messageType === MESSAGE_TYPES.USER_MESSAGE) return 'user';
  if (messageType === MESSAGE_TYPES.ERROR) return 'error';
  return 'assistant';
}

function renderLogEntryText(
  role: ConversationEntry['role'],
  text: string,
): string {
  switch (role) {
    case 'error':
      return appendCliApiSwitchHint(text);
    case 'user':
      return summarizeSubagentFollowup(stripOrchestratorFollowup(text));
    default:
      return text;
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
    if (prev?.toolUse && toolUseSourceCache.get(prev) === entry.data) {
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

  const text = entry.text ?? '';
  const role = logEntryRole(entry.messageType);
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
    finalized,
  };
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
      return true;
    case 'tool':
      return entry.toolUse?.status === TOOL_USE_STATUS.COMPLETED;
    case 'assistant':
      return index < entries.length - 1;
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

export function subscribeStreamLog(): () => void {
  const store = getDefaultStreamLogStore();
  const pendingTimers = new Map<StreamTabId, ReturnType<typeof setTimeout>>();

  const dispose = store.onChange((streamId) => {
    if (pendingTimers.has(streamId)) return;
    const timer = setTimeout(() => {
      pendingTimers.delete(streamId);
      syncStreamLog(streamId);
    }, STREAM_SYNC_THROTTLE_MS);
    pendingTimers.set(streamId, timer);
  });

  return () => {
    dispose();
    for (const timer of pendingTimers.values()) clearTimeout(timer);
    pendingTimers.clear();
  };
}

export function syncStreamLog(streamId: StreamTabId): void {
  // AgentTrace throttles MODEL_RESPONSE chunks into the store via a 50ms
  // timer. If we read before that timer fires (e.g. the stream finalized
  // between two TUI sync ticks), the assistant text is still sitting in
  // an in-memory buffer and never reaches the transcript. Force any
  // pending flushers to materialize before we read.
  flushPendingRunTraces();
  const store = getDefaultStreamLogStore();
  const log = store.get(streamId);
  if (!log) return;

  const transcriptMessageTypes = transcriptMessageTypesForStream(streamId);
  const responses = log
    .getRange(0)
    .filter((entry: StreamLogEntry) =>
      transcriptMessageTypes.has(entry.messageType ?? ''),
    );

  patchStream(streamId, (slice) => {
    const existing = new Map(slice.entries.map((e) => [e.id, e]));
    const syntheticEntries = slice.entries.filter((entry) => entry.synthetic);
    const streamFinal = isFinalTranscriptStatus(slice.status);
    const logEntries: { entry: StreamLogEntry; rendered: ConversationEntry }[] =
      [];
    for (const entry of responses) {
      const rendered = renderLogEntry(entry, existing.get(entry.id));
      if (!rendered) continue;
      logEntries.push({ entry, rendered });
    }
    const logCandidates: TranscriptCandidate[] = logEntries.map(
      ({ entry, rendered }) => ({
        rendered,
        sortSeq: entry.seqNo,
        tieBreak: 0,
      }),
    );
    const candidates: TranscriptCandidate[] = [...logCandidates];

    for (const [index, entry] of syntheticEntries.entries()) {
      if (entry.syntheticKind !== 'local') {
        const entryTextTrimmed = entry.text.trim();
        const duplicate = logCandidates.some(
          (candidate) =>
            candidate.rendered.role === entry.role &&
            candidate.rendered.text.trim() === entryTextTrimmed,
        );
        if (duplicate) continue;
      }

      candidates.push({
        rendered: entry,
        sortSeq: entry.syntheticAfterSeq ?? Number.POSITIVE_INFINITY,
        tieBreak: index + 1,
      });
    }

    const ordered = candidates
      .sort(
        (left, right) =>
          left.sortSeq - right.sortSeq || left.tieBreak - right.tieBreak,
      )
      .map((candidate) => candidate.rendered);
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
    if (!changed) return slice;
    return { ...slice, entries: next };
  });

  // Surface stream as active if we don't already have one — handles bare
  // `texra chat` where setActiveStream is the first signal the runtime emits.
  if (!cliState.activeStreamId.get()) {
    cliState.activeStreamId.set(streamId);
  }
}
