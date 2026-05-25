// Mirror StreamLogStore user/model/tool entries into
// `cliState.streams[].entries`. Approval/permission entries land in side
// panels and modals; tool rows render inline alongside assistant prose.

import { getDefaultStreamLogStore } from '@transcript';
import { flushPendingRunTraces } from '@logger';
import {
  MESSAGE_TYPES,
  type NormalizedToolUse,
  type StreamLogEntry,
  type StreamTabId,
} from '@shared/schemas';
import { normalizeToolUseData } from '@shared/toolUse';

import { appendCliApiSwitchHint } from '../../../runtime/approvalAdapter';
import { cliState, patchStream, type ConversationEntry } from './cliState';
import { summarizeSubagentFollowup } from './subagentFollowup';
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

export function isSubagentContinuationMessage(text: string): boolean {
  return /^<subagent-(progress|result)(?:\s[^>]*)?(?:\/>|>[\s\S]*<\/subagent-\1>)$/.test(
    text.trim(),
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

function renderLogEntry(
  entry: StreamLogEntry,
  prev: ConversationEntry | undefined,
  finalizeDeferred: boolean,
): ConversationEntry | null {
  if (entry.messageType === MESSAGE_TYPES.TOOL_USE) {
    // Cache hit: same `data` reference as last sync, no re-normalize.
    // Still honor a pending finalize — otherwise a tool row whose payload
    // stopped changing before the stream went idle would never promote
    // into `<Static>` scrollback and would vanish per splitTranscriptEntries.
    if (prev?.toolUse && toolUseSourceCache.get(prev) === entry.data) {
      if (finalizeDeferred && !prev.finalized) {
        const promoted = { ...prev, finalized: true };
        toolUseSourceCache.set(promoted, entry.data);
        return promoted;
      }
      return prev;
    }

    const toolUse = normalizeToolUseData(entry.data);
    // Drop malformed tool entries rather than crash. The progress view
    // does the same — a bad payload shouldn't take down the transcript.
    if (!toolUse) return null;
    // Defer finalization to `finalizeAssistantTranscriptEntries`. A
    // fast-completing tool would otherwise jump into `<Static>`
    // scrollback while preceding assistant text from the same turn is
    // still streaming, reversing the visible order (Static items are
    // append-only). Inherit the prior flag so a sync tick that fires
    // after the finalize step doesn't roll the entry back to false.
    const next: ConversationEntry = {
      id: entry.id,
      role: 'tool',
      text: '',
      finalized: finalizeDeferred || (prev?.finalized ?? false),
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
  const renderedText =
    role === 'error'
      ? appendCliApiSwitchHint(text)
      : role === 'user'
        ? summarizeSubagentFollowup(stripOrchestratorFollowup(text))
        : text;
  // Assistant entries defer finalization (see comment above); inherit
  // from `prev` so re-syncs after finalize don't de-finalize and drop
  // the entry from `splitTranscriptEntries` once status flips to
  // WAITING.
  const finalized =
    role === 'assistant'
      ? finalizeDeferred || (prev?.finalized ?? false)
      : true;
  const next: ConversationEntry = {
    id: entry.id,
    role,
    text: renderedText,
    finalized,
  };
  return prev && entriesEqual(prev, next) ? prev : next;
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
    const finalizeDeferred = isFinalTranscriptStatus(slice.status);
    const logEntries: { entry: StreamLogEntry; rendered: ConversationEntry }[] =
      [];
    for (const entry of responses) {
      const rendered = renderLogEntry(
        entry,
        existing.get(entry.id),
        finalizeDeferred,
      );
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
        const duplicate = logCandidates.some(
          (candidate) =>
            candidate.rendered.role === entry.role &&
            candidate.rendered.text.trim() === entry.text.trim(),
        );
        if (duplicate) continue;
      }

      candidates.push({
        rendered: entry,
        sortSeq: entry.syntheticAfterSeq ?? Number.POSITIVE_INFINITY,
        tieBreak: index + 1,
      });
    }

    const next = candidates
      .sort(
        (left, right) =>
          left.sortSeq - right.sortSeq || left.tieBreak - right.tieBreak,
      )
      .map((candidate) => candidate.rendered);

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
