import type { StreamLogEntry, StreamTabId } from '@shared/schemas';
import type { StreamLogAppendInput } from '@shared/session/traceEntries';
import type {
  StreamLogStore,
  TranscriptWriter,
} from '@transcript/StreamLogStore';

/**
 * Run `mutate` under a short-lived {@link TranscriptWriter} — the public
 * transcript mutation path (#9590 Stage 5: row mutation is writer-only).
 * Acquires and closes the writer around the callback so tests keep their
 * previous call-site shape without holding writer ownership across steps.
 */
function withTranscriptWriter<T>(
  store: StreamLogStore,
  streamId: StreamTabId,
  mutate: (writer: TranscriptWriter) => T,
): T {
  const writer = store.acquireWriter(streamId, `test-writer:${streamId}`);
  try {
    return mutate(writer);
  } finally {
    writer.close();
  }
}

/** Append one transcript row through the writer path. */
export function appendTranscriptEntry(
  store: StreamLogStore,
  streamId: StreamTabId,
  entry: StreamLogAppendInput,
): StreamLogEntry {
  return withTranscriptWriter(store, streamId, (writer) =>
    writer.append(entry),
  );
}

/** Patch one transcript row through the writer path. */
export function updateTranscriptEntry(
  store: StreamLogStore,
  streamId: StreamTabId,
  id: string,
  patch: Parameters<TranscriptWriter['update']>[1],
): StreamLogEntry | undefined {
  return withTranscriptWriter(store, streamId, (writer) =>
    writer.update(id, patch),
  );
}

/** Append streaming text to one transcript row through the writer path. */
export function appendTranscriptText(
  store: StreamLogStore,
  streamId: StreamTabId,
  id: string,
  text: string,
): StreamLogEntry | undefined {
  return withTranscriptWriter(store, streamId, (writer) =>
    writer.appendText(id, text),
  );
}
