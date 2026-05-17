// Mirror StreamLogStore user/model entries into `cliState.streams[].entries`.
// Tool/approval entries land in side panels and modals.

import { AgentLogger } from '@logger/AgentLogger';
import {
  MESSAGE_TYPES,
  type StreamLogEntry,
  type StreamTabId,
} from '@shared/schemas';

import { cliState, patchStream, type ConversationEntry } from './cliState';
import { getTranscriptStartSeq } from './transcript';

const TRANSCRIPT_MESSAGE_TYPES = new Set<string>([
  MESSAGE_TYPES.ERROR,
  MESSAGE_TYPES.MODEL_RESPONSE,
  MESSAGE_TYPES.USER_MESSAGE,
]);

const STREAM_SYNC_THROTTLE_MS = 200;

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
    const logEntries = responses.map((entry: StreamLogEntry) => {
      const text = entry.text ?? '';
      const role: ConversationEntry['role'] =
        entry.messageType === MESSAGE_TYPES.USER_MESSAGE
          ? 'user'
          : entry.messageType === MESSAGE_TYPES.ERROR
            ? 'error'
            : 'assistant';
      const prev = existing.get(entry.id);
      const rendered =
        prev && prev.text === text && prev.role === role
          ? prev
          : { id: entry.id, role, text, finalized: role !== 'assistant' };
      return { entry, rendered };
    });
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
          entry.role !== candidate.role ||
          entry.text !== candidate.text ||
          entry.finalized !== candidate.finalized
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
