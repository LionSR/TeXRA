/**
 * Local CLI rows: notices the TUI itself prints into a conversation (a model
 * fallback, a skill activation, a slash-command result). They are not
 * events and never part of the session view; they are one list of
 * `{ runId, row }`, joined into the run's rows by the notice row's `seqNo`
 * (the position it was written after) in {@link conversationRows}: a join of
 * two inputs ordered by the same transcript seq, so a row the session view's
 * residency cap drops never shifts a notice.
 */
import { randomUUID } from 'node:crypto';

import { computed } from '@lit-labs/signals';
import { Cause, Effect } from 'effect';

import { withLogChannel } from '@texra-ai/harness/plugins';
import { transcriptText } from '@texra-ai/harness/transcript';
import { toErrorMessage, type RequestError } from '@texra-ai/harness/schemas';
import type { TranscriptRow } from '@cli/chat/tui/state/sessionView';
import { requestErrorText } from '@ui/copy/requestErrors';
import {
  CLI_LOCAL_RUN_ID,
  focusRun,
  foregroundReader,
  selectedRunId,
  rootRunId,
  chatField,
  sessionRunIds,
} from './cliState';
import { currentView, runViewOf } from './sessionView';
import type { RunView, RunId, SessionView } from '@texra-ai/harness/schemas';

/**
 * The runs whose transcript tier this terminal keeps resident: its
 * conversation, the runs it owns, and an open reader's run. The view also
 * lists every earlier run of the workspace, loaded from the listing;
 * subscribing all of those loaded every past transcript into memory for the
 * life of the TUI.
 */
export const paintedRunIds = computed((): readonly RunId[] => {
  const reader = foregroundReader.get()?.runId;
  return [...sessionRunIds.get(), ...(reader ? [reader] : [])];
});

export interface LocalNotice {
  readonly runId: RunId;
  /** Its `seqNo` is the transcript seq of the row it follows; 0 before any. */
  readonly row: TranscriptRow;
}

/** The transcript seq a row finishes at, for the notice join. */
function rowSeq(row: TranscriptRow): number {
  return row.finalSeqNo ?? row.seqNo;
}

export const notices = chatField('localNotices');

/** A result the TUI itself reports (a slash command, a model fallback): a
 *  dim, marked row, so it never reads as the model speaking. */
export function appendLocalNotice(text: string, runId?: RunId): void {
  appendLocalTranscriptEntry('notice', text, runId);
}

export function appendLocalErrorTranscript(text: string, runId?: RunId): void {
  appendLocalTranscriptEntry('error', text, runId);
}

export function appendLocalUserTranscript(text: string): void {
  appendLocalTranscriptEntry('user', text);
}

/** The one non-event row producer. */
function localTranscriptRow(
  kind: 'notice' | 'error' | 'user',
  id: string,
  seqNo: number,
  text: string,
): TranscriptRow {
  const base = { id, seqNo, origin: 'local', timestamp: Date.now() } as const;
  const body = transcriptText(text);
  if (kind === 'error') {
    return {
      ...base,
      level: 'error',
      kind: 'error',
      summary: body,
      details: [],
    };
  }
  if (kind === 'user') {
    return {
      ...base,
      level: 'info',
      kind: 'user',
      text: body,
      attachments: [],
      media: [],
    };
  }
  return { ...base, level: 'info', kind: 'log', text: body };
}

function appendLocalTranscriptEntry(
  kind: 'notice' | 'error' | 'user',
  text: string,
  explicitRunId?: RunId,
): void {
  const normalized = text.trim();
  if (!normalized) return;
  const view = currentView();
  const active = selectedRunId.get();
  // A local row lands on the root run once one exists, else on the active
  // run's parent (or the active run itself), else on the pre-run transcript.
  const runId =
    explicitRunId ??
    rootRunId.get() ??
    (active === undefined
      ? CLI_LOCAL_RUN_ID
      : (runViewOf(view, active)?.parentId ?? active));
  focusRun(runId, { when: 'unset' });
  const last = runViewOf(view, runId)?.transcript.rows.at(-1);
  notices.set([
    ...notices.get(),
    {
      runId,
      row: localTranscriptRow(
        kind,
        `local:${randomUUID()}`,
        last === undefined ? 0 : rowSeq(last),
        normalized,
      ),
    },
  ]);
}

/** The pre-run notices become the root's opening rows once it exists. */
export function moveLocalTranscriptToRun(runId: RunId): void {
  if (runId === CLI_LOCAL_RUN_ID) return;
  const current = notices.get();
  if (!current.some((notice) => notice.runId === CLI_LOCAL_RUN_ID)) {
    return;
  }
  notices.set(
    current.map((notice) =>
      notice.runId === CLI_LOCAL_RUN_ID
        ? { runId, row: { ...notice.row, seqNo: 0 } }
        : notice,
    ),
  );
  focusRun(runId, { when: 'local' });
}

export function clearLocalTranscript(): void {
  const current = notices.get();
  const kept = current.filter((notice) => notice.runId !== CLI_LOCAL_RUN_ID);
  if (kept.length !== current.length) notices.set(kept);
  focusRun(null, { when: 'local' });
}

/**
 * A run's rows as the conversation paints them: its transcript with this
 * TUI's notices for it inserted after the last row whose seq is at or below
 * their own `seqNo`, in notice order, so the merged index is the print
 * order. A notice written before the run's first row goes ahead of it. The
 * merged `finalRows` is the finished prefix plus every notice anchored
 * inside it (a notice is immutable the moment it is written, and keeps its
 * identity across merges). Both conversation panes read this one join.
 */
export function conversationRows(
  view: SessionView,
  all: readonly LocalNotice[],
  runId: RunId | undefined,
): {
  readonly run: RunView | undefined;
  readonly rows: readonly TranscriptRow[];
  readonly finalRows: number;
} {
  const run = runViewOf(view, runId);
  const rows = run?.transcript.rows ?? [];
  const finalRows = run?.transcript.finalRows ?? 0;
  const runNotices =
    runId === undefined ? [] : all.filter((notice) => notice.runId === runId);
  if (runNotices.length === 0) return { run, rows, finalRows };
  const finalSeq = finalRows === 0 ? 0 : rowSeq(rows[finalRows - 1]);
  const out: TranscriptRow[] = [];
  let next = 0;
  const flushThrough = (seq: number): void => {
    while (next < rows.length && rowSeq(rows[next]) <= seq) {
      out.push(rows[next]);
      next += 1;
    }
  };
  for (const { row } of runNotices.toSorted(
    (a, b) => a.row.seqNo - b.row.seqNo,
  )) {
    flushThrough(row.seqNo);
    out.push(row);
  }
  for (; next < rows.length; next += 1) out.push(rows[next]);
  return {
    run,
    rows: out,
    finalRows:
      finalRows +
      runNotices.filter((notice) => notice.row.seqNo <= finalSeq).length,
  };
}

/** A refused runtime request, worded into the run it named. The user's own
 *  cancellation is not a failure and writes nothing. */
export function appendLocalRequestRefusal(
  error: RequestError,
  runId?: RunId,
): void {
  if (error._tag === 'Cancelled') return;
  appendLocalErrorTranscript(requestErrorText(error), runId);
}

const CHANNEL = 'cli.transcript';

/**
 * A runtime request that defected in process: `SessionBridge` logs the cause
 * and answers `Internal`; with no bridge in the middle the same defect is
 * logged here and worded for the surface that issued the request. The CLI's
 * log sink is silent, so the wording carries the cause itself.
 */
export function reportRequestDefect(
  cause: Cause.Cause<unknown>,
): Effect.Effect<string> {
  const message = toErrorMessage(cause);
  return Effect.logError(`Runtime request failed: ${message}`).pipe(
    withLogChannel(CHANNEL),
    Effect.as(`The request failed inside TeXRA: ${message}`),
  );
}
