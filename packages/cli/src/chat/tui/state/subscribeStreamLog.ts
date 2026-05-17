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

/** Signature of a tool entry's renderable fields. The store updates the
 *  TOOL_USE entry in place (`status: 'in_progress'` → `'completed'`,
 *  `output`/`error` filled later), so a text-only equality check would
 *  miss those transitions. */
function toolUseSignature(toolUse: NormalizedToolUse): string {
  return [
    toolUse.status ?? '',
    toolUse.toolName,
    toolUse.outputText,
    toolUse.errorText,
    toolUse.headerSummary,
    toolUse.isError ? '1' : '0',
  ].join(' ');
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
    return toolUseSignature(prev.toolUse) === toolUseSignature(next.toolUse);
  }
  return true;
}

function renderLogEntry(
  entry: StreamLogEntry,
  prev: ConversationEntry | undefined,
): ConversationEntry | null {
  if (entry.messageType === MESSAGE_TYPES.TOOL_USE) {
    const toolUse = normalizeToolUseData(entry.data);
    // Drop malformed tool entries rather than crash. The progress view
    // does the same — a bad payload shouldn't take down the transcript.
    if (!toolUse) return null;
    const finalized = toolUse.status === 'completed';
    const next: ConversationEntry = {
      id: entry.id,
      role: 'tool',
      text: '',
      finalized,
      toolUse,
    };
    return prev && entriesEqual(prev, next) ? prev : next;
  }

  const text = entry.text ?? '';
  const role: ConversationEntry['role'] =
    entry.messageType === MESSAGE_TYPES.USER_MESSAGE
      ? 'user'
      : entry.messageType === MESSAGE_TYPES.ERROR
        ? 'error'
        : 'assistant';
  const next: ConversationEntry = {
    id: entry.id,
    role,
    text,
    finalized: role !== 'assistant',
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
