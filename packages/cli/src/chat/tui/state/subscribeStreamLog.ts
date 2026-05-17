// Mirror StreamLogStore user/model/tool entries into
// `cliState.streams[].entries`. Approval/permission entries land in side
// panels and modals; tool rows render inline alongside assistant prose.

import { AgentLogger } from '@logger/AgentLogger';
import {
  MESSAGE_TYPES,
  type NormalizedToolUse,
  type StreamLogEntry,
  type StreamTabId,
} from '@shared/schemas';
import { normalizeToolUseData } from '@shared/toolUse';

import { cliState, patchStream, type ConversationEntry } from './cliState';
import { getTranscriptStartSeq } from './transcript';

const TRANSCRIPT_MESSAGE_TYPES = new Set<string>([
  MESSAGE_TYPES.ERROR,
  MESSAGE_TYPES.MODEL_RESPONSE,
  MESSAGE_TYPES.TOOL_USE,
  MESSAGE_TYPES.USER_MESSAGE,
]);

// Field-by-field — a stringified signature would allocate the full
// outputText (potentially 50 KB+ of bash output) on every comparison.
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
    prev.isError === next.isError
  );
}

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
  return true;
}

function renderLogEntry(
  entry: StreamLogEntry,
  prev: ConversationEntry | undefined,
): ConversationEntry | null {
  if (entry.messageType === MESSAGE_TYPES.TOOL_USE) {
    // StreamLog.update spreads into a fresh `data` object on every patch
    // (StreamLog.ts:89-94), so identity equality is a reliable signal
    // that the entry hasn't changed since the last sync. Skipping the
    // Zod parse + YAML stringify here matters because syncStreamLog runs
    // ~every animation frame during streaming and tool output can be
    // 50 KB+ per completed entry.
    if (prev?.toolUse && prev.toolUseSource === entry.data) return prev;

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
      finalized: prev?.finalized ?? false,
      toolUse,
      toolUseSource: entry.data,
    };
    if (prev && entriesEqual(prev, next)) {
      // Same content under a fresh `data` reference: refresh the cache
      // key on `prev` instead of returning it as-is, otherwise the
      // identity fast path above keeps missing on every subsequent tick.
      return prev.toolUseSource === entry.data
        ? prev
        : { ...prev, toolUseSource: entry.data };
    }
    return next;
  }

  const text = entry.text ?? '';
  const role: ConversationEntry['role'] =
    entry.messageType === MESSAGE_TYPES.USER_MESSAGE
      ? 'user'
      : entry.messageType === MESSAGE_TYPES.ERROR
        ? 'error'
        : 'assistant';
  // Assistant entries defer finalization (see comment above); inherit
  // from `prev` so re-syncs after finalize don't de-finalize and drop
  // the entry from `splitTranscriptEntries` once status flips to
  // WAITING.
  const finalized = role === 'assistant' ? (prev?.finalized ?? false) : true;
  const next: ConversationEntry = {
    id: entry.id,
    role,
    text,
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
  const store = AgentLogger.getStreamLogStore();
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
  // AgentLogger throttles MODEL_RESPONSE chunks into the store via a 50ms
  // timer. If we read before that timer fires (e.g. the stream finalized
  // between two TUI sync ticks), the assistant text is still sitting in
  // an in-memory buffer and never reaches the transcript. Force any
  // pending flushers to materialize before we read.
  AgentLogger.flushPendingStreamUpdates();
  const store = AgentLogger.getStreamLogStore();
  const log = store.get(streamId);
  if (!log) return;

  const responses = log
    .getRange(getTranscriptStartSeq(streamId))
    .filter((entry: StreamLogEntry) =>
      TRANSCRIPT_MESSAGE_TYPES.has(entry.messageType ?? ''),
    );

  patchStream(streamId, (slice) => {
    const existing = new Map(slice.entries.map((e) => [e.id, e]));
    const syntheticEntries = slice.entries.filter((entry) => entry.synthetic);
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
