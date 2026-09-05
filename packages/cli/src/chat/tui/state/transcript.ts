/**
 * Local CLI rows: notices the TUI itself prints into a conversation (a model
 * fallback, a skill activation, a slash-command result). They are not
 * events and never fold; they are Surface (PRD one-fold-three-renderers,
 * 9), one list of `{ streamId, afterSeq, row }`, and the conversation panes
 * merge them into the stream's folded rows by `afterSeq` at render: a join
 * of two inputs ordered by the same transcript seq, so a row the fold's
 * residency cap drops never shifts a notice.
 */
import { signal } from '@lit-labs/signals';

import type { StreamTabId } from '@shared/schemas';
import { transcriptText, type TranscriptRow } from '@shared/transcript';
import type { RequestError } from '@shared/session/requestErrors';
import {
  activeStreamId,
  focusStream,
  rootStreamId,
  registerCliStateResetHook,
} from './cliState';
import { currentView, streamViewOf } from './sessionView';

/** Where notices land before the root run has a stream. */
export const CLI_LOCAL_STREAM_ID = 'cli-local' as StreamTabId;

export interface LocalNotice {
  readonly streamId: StreamTabId;
  /** The settlement seq of the folded row the notice follows; 0 before any. */
  readonly afterSeq: number;
  readonly row: TranscriptRow;
}

/** The transcript seq a folded row settles at, for the notice join. */
function rowSeq(row: TranscriptRow | undefined): number {
  return row?.settlementSeqNo ?? row?.seqNo ?? 0;
}

export const notices = signal<readonly LocalNotice[]>([]);

let localEntrySeq = 0;

export function appendLocalAssistantTranscript(
  text: string,
  streamId?: StreamTabId,
): void {
  appendLocalTranscriptEntry('assistant', text, streamId);
}

export function appendLocalErrorTranscript(text: string): void {
  appendLocalTranscriptEntry('error', text);
}

export function appendLocalUserTranscript(text: string): void {
  appendLocalTranscriptEntry('user', text);
}

function localTranscriptRow(
  kind: 'assistant' | 'error' | 'user',
  id: string,
  text: string,
): TranscriptRow {
  const base = { id, origin: 'local', timestamp: Date.now() } as const;
  const body = transcriptText(text);
  if (kind === 'error') {
    return {
      ...base,
      level: 'error',
      kind: 'error',
      summary: body,
      details: [],
      detailText: transcriptText(''),
    };
  }
  if (kind === 'user') {
    return { ...base, level: 'info', kind: 'user', text: body, summary: body };
  }
  return {
    ...base,
    level: 'info',
    kind: 'assistant',
    text: body,
    streaming: false,
  };
}

function appendLocalTranscriptEntry(
  kind: 'assistant' | 'error' | 'user',
  text: string,
  explicitStreamId?: StreamTabId,
): void {
  const normalized = text.trim();
  if (!normalized) return;
  const view = currentView();
  const active = activeStreamId.get();
  const streamId =
    explicitStreamId ??
    resolveLocalTranscriptStreamId({
      activeStreamId: active,
      fallbackStreamId: CLI_LOCAL_STREAM_ID,
      parentOf: (id) => streamViewOf(view, id)?.parentId ?? undefined,
      rootStreamId: rootStreamId.get(),
    });
  focusStream(streamId, { onlyIfUnset: true });
  const afterSeq = rowSeq(streamViewOf(view, streamId)?.transcript.rows.at(-1));
  notices.set([
    ...notices.get(),
    {
      streamId,
      afterSeq,
      row: localTranscriptRow(
        kind,
        `local:${localEntrySeq++}:${streamId}`,
        normalized,
      ),
    },
  ]);
}

export function resolveLocalTranscriptStreamId({
  activeStreamId,
  fallbackStreamId,
  parentOf,
  rootStreamId,
}: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly fallbackStreamId: StreamTabId;
  readonly parentOf: (streamId: StreamTabId) => StreamTabId | undefined;
  readonly rootStreamId: StreamTabId | undefined;
}): StreamTabId {
  if (rootStreamId) return rootStreamId;
  if (activeStreamId === undefined) return fallbackStreamId;
  return parentOf(activeStreamId) ?? activeStreamId;
}

/** The pre-run notices become the root's opening rows once it has a stream. */
export function moveLocalTranscriptToStream(streamId: StreamTabId): void {
  if (streamId === CLI_LOCAL_STREAM_ID) return;
  const current = notices.get();
  if (!current.some((notice) => notice.streamId === CLI_LOCAL_STREAM_ID)) {
    return;
  }
  notices.set(
    current.map((notice) =>
      notice.streamId === CLI_LOCAL_STREAM_ID
        ? { ...notice, streamId, afterSeq: 0 }
        : notice,
    ),
  );
  if (activeStreamId.get() === CLI_LOCAL_STREAM_ID) focusStream(streamId);
}

export function clearLocalTranscript(): void {
  const current = notices.get();
  const kept = current.filter(
    (notice) => notice.streamId !== CLI_LOCAL_STREAM_ID,
  );
  if (kept.length !== current.length) notices.set(kept);
  if (activeStreamId.get() === CLI_LOCAL_STREAM_ID) {
    activeStreamId.set(undefined);
  }
}

export function noticesFor(
  all: readonly LocalNotice[],
  streamId: StreamTabId | undefined,
): readonly LocalNotice[] {
  return streamId === undefined
    ? []
    : all.filter((notice) => notice.streamId === streamId);
}

/**
 * The stream's folded rows with its notices inserted after the last row
 * whose seq is at or below their `afterSeq`, in notice order; a notice
 * takes that row's settlement key so the pane's settlement ordering keeps it
 * in place.
 */
export function mergeLocalNotices(
  rows: readonly TranscriptRow[],
  streamNotices: readonly LocalNotice[],
): readonly TranscriptRow[] {
  if (streamNotices.length === 0) return rows;
  const out: TranscriptRow[] = [];
  let next = 0;
  const flushThrough = (seq: number): void => {
    while (next < rows.length && rowSeq(rows[next]) <= seq) {
      out.push(rows[next]!);
      next += 1;
    }
  };
  for (const notice of [...streamNotices].sort(
    (a, b) => a.afterSeq - b.afterSeq,
  )) {
    flushThrough(notice.afterSeq);
    const previous = out.at(-1);
    const seq = previous?.settlementSeqNo ?? previous?.seqNo;
    out.push(
      seq === undefined
        ? notice.row
        : { ...notice.row, seqNo: seq, settlementSeqNo: seq },
    );
  }
  for (; next < rows.length; next += 1) out.push(rows[next]!);
  return out;
}

/** How many merged rows are settled: the folded prefix plus every notice
 *  anchored inside it (a notice is immutable the moment it is written). */
export function mergedSettledRows(
  rows: readonly TranscriptRow[],
  settledRows: number,
  streamNotices: readonly LocalNotice[],
): number {
  const settledSeq = settledRows === 0 ? 0 : rowSeq(rows[settledRows - 1]);
  return (
    settledRows +
    streamNotices.filter((notice) => notice.afterSeq <= settledSeq).length
  );
}

/** The refusal a request error reads as, for the local transcript. */
export function describeRequestError(error: RequestError): string {
  switch (error._tag) {
    case 'NotOwner':
      return 'Another process owns this conversation.';
    case 'Unavailable':
    case 'Rejected':
      return error.reason;
  }
}

/** A refused runtime request, worded into the stream it named. */
export function appendLocalRequestRefusal(
  error: RequestError,
  streamId: StreamTabId,
): void {
  appendLocalAssistantTranscript(describeRequestError(error), streamId);
}

registerCliStateResetHook(() => {
  localEntrySeq = 0;
  notices.set([]);
});
