/**
 * Local CLI rows: notices the TUI itself prints into a conversation (a model
 * fallback, a skill activation, a slash-command result). They are not
 * events and never fold; they are Surface (PRD one-fold-three-renderers,
 * 9), one list of `{ runId, afterSeq, row }`, and the conversation panes
 * merge them into the stream's folded rows by `afterSeq` at render: a join
 * of two inputs ordered by the same transcript seq, so a row the fold's
 * residency cap drops never shifts a notice.
 */
import { signal } from '@lit-labs/signals';

import type { RunId } from '@shared/schemas';
import { transcriptText, type TranscriptRow } from '@shared/transcript';
import type { RequestError } from '@shared/session/requestErrors';
import {
  activeRunId,
  focusRun,
  rootRunId,
  registerCliStateResetHook,
} from './cliState';
import { currentView, runViewOf } from './sessionView';

/** Where notices land before the root run has a stream. */
export const CLI_LOCAL_STREAM_ID = 'cli-local' as RunId;

export interface LocalNotice {
  readonly runId: RunId;
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
  runId?: RunId,
): void {
  appendLocalTranscriptEntry('assistant', text, runId);
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
  explicitRunId?: RunId,
): void {
  const normalized = text.trim();
  if (!normalized) return;
  const view = currentView();
  const active = activeRunId.get();
  const runId =
    explicitRunId ??
    resolveLocalTranscriptRunId({
      activeRunId: active,
      fallbackRunId: CLI_LOCAL_STREAM_ID,
      parentOf: (id) => runViewOf(view, id)?.parentId ?? undefined,
      rootRunId: rootRunId.get(),
    });
  focusRun(runId, { onlyIfUnset: true });
  const afterSeq = rowSeq(runViewOf(view, runId)?.transcript.rows.at(-1));
  notices.set([
    ...notices.get(),
    {
      runId,
      afterSeq,
      row: localTranscriptRow(
        kind,
        `local:${localEntrySeq++}:${runId}`,
        normalized,
      ),
    },
  ]);
}

export function resolveLocalTranscriptRunId({
  activeRunId,
  fallbackRunId,
  parentOf,
  rootRunId,
}: {
  readonly activeRunId: RunId | undefined;
  readonly fallbackRunId: RunId;
  readonly parentOf: (runId: RunId) => RunId | undefined;
  readonly rootRunId: RunId | undefined;
}): RunId {
  if (rootRunId) return rootRunId;
  if (activeRunId === undefined) return fallbackRunId;
  return parentOf(activeRunId) ?? activeRunId;
}

/** The pre-run notices become the root's opening rows once it has a stream. */
export function moveLocalTranscriptToRun(runId: RunId): void {
  if (runId === CLI_LOCAL_STREAM_ID) return;
  const current = notices.get();
  if (!current.some((notice) => notice.runId === CLI_LOCAL_STREAM_ID)) {
    return;
  }
  notices.set(
    current.map((notice) =>
      notice.runId === CLI_LOCAL_STREAM_ID
        ? { ...notice, runId, afterSeq: 0 }
        : notice,
    ),
  );
  if (activeRunId.get() === CLI_LOCAL_STREAM_ID) focusRun(runId);
}

export function clearLocalTranscript(): void {
  const current = notices.get();
  const kept = current.filter(
    (notice) => notice.runId !== CLI_LOCAL_STREAM_ID,
  );
  if (kept.length !== current.length) notices.set(kept);
  if (activeRunId.get() === CLI_LOCAL_STREAM_ID) {
    activeRunId.set(undefined);
  }
}

export function noticesFor(
  all: readonly LocalNotice[],
  runId: RunId | undefined,
): readonly LocalNotice[] {
  return runId === undefined
    ? []
    : all.filter((notice) => notice.runId === runId);
}

/**
 * The stream's folded rows with its notices inserted after the last row
 * whose seq is at or below their `afterSeq`, in notice order; a notice
 * takes that row's settlement key so the pane's settlement ordering keeps it
 * in place.
 */
export function mergeLocalNotices(
  rows: readonly TranscriptRow[],
  runNotices: readonly LocalNotice[],
): readonly TranscriptRow[] {
  if (runNotices.length === 0) return rows;
  const out: TranscriptRow[] = [];
  let next = 0;
  const flushThrough = (seq: number): void => {
    while (next < rows.length && rowSeq(rows[next]) <= seq) {
      out.push(rows[next]!);
      next += 1;
    }
  };
  for (const notice of [...runNotices].sort(
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
  runNotices: readonly LocalNotice[],
): number {
  const settledSeq = settledRows === 0 ? 0 : rowSeq(rows[settledRows - 1]);
  return (
    settledRows +
    runNotices.filter((notice) => notice.afterSeq <= settledSeq).length
  );
}

/** The refusal a request error reads as, for the local transcript. */
export function describeRequestError(error: RequestError): string {
  switch (error._tag) {
    case 'Cancelled':
      return 'The operation was cancelled.';
    case 'NotOwner':
      return 'Another process owns this conversation.';
    case 'Unavailable':
    case 'Rejected':
      return error.reason;
    case 'Internal':
      return `The request failed inside TeXRA (ref ${error.ref}); see the log.`;
  }
}

/** A refused runtime request, worded into the stream it named. */
export function appendLocalRequestRefusal(
  error: RequestError,
  runId: RunId,
): void {
  appendLocalAssistantTranscript(describeRequestError(error), runId);
}

registerCliStateResetHook(() => {
  localEntrySeq = 0;
  notices.set([]);
});
