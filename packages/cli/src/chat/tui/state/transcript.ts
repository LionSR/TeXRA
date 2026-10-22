/**
 * Local CLI rows: notices the TUI itself prints into a conversation (a model
 * fallback, a skill activation, a slash-command result). They are not
 * events and never fold; they are Surface (PRD one-fold-three-renderers,
 * 9), one list of `{ runId, afterSeq, row }`, and the conversation panes
 * merge them into the run's folded rows by `afterSeq` at render: a join
 * of two inputs ordered by the same transcript seq, so a row the fold's
 * residency cap drops never shifts a notice.
 */
import { computed, signal } from '@lit-labs/signals';
import { Cause, Effect } from 'effect';

import { withLogChannel } from '@texra-ai/harness';
import { transcriptText } from '@texra-ai/harness/transcript';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import type { TranscriptRow } from '@cli/chat/tui/state/sessionView';
import { requestErrorText } from '@ui/copy/requestErrors';
import {
  CLI_LOCAL_RUN_ID,
  focusRun,
  foregroundReader,
  selectedRunId,
  rootRunId,
  registerCliStateResetHook,
  sessionRunIds,
} from './cliState';
import { currentView, runViewOf } from './sessionView';
import type { RequestError } from '@texra-ai/harness';
import type { RunView, RunId } from '@texra-ai/harness/schemas';

/**
 * The runs whose transcript tier this terminal keeps resident: its
 * conversation, the runs it owns, and an open reader's run. The view also
 * lists every earlier run of the workspace, hydrated from the listing;
 * subscribing all of those folded every past transcript into memory for the
 * life of the TUI.
 */
export const paintedRunIds = computed((): readonly RunId[] => {
  const reader = foregroundReader.get()?.runId;
  return [...sessionRunIds.get(), ...(reader ? [reader] : [])];
});

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
        ? { ...notice, runId, afterSeq: 0 }
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

export function noticesFor(
  all: readonly LocalNotice[],
  runId: RunId | undefined,
): readonly LocalNotice[] {
  return runId === undefined
    ? []
    : all.filter((notice) => notice.runId === runId);
}

/**
 * The run's folded rows with its notices inserted after the last row
 * whose seq is at or below their `afterSeq`, in notice order. A notice's
 * settlement key is its `afterSeq`: the pane re-sorts by that key with a
 * local-after-folded tiebreak, so the key alone keeps the notice after the
 * row it follows. A notice written before the run's first row keys at 0 and
 * sorts ahead of it. The merged `settledRows` is the folded prefix plus every
 * notice anchored inside it (a notice is immutable the moment it is written).
 */
export function mergeLocalNotices(
  run: RunView | undefined,
  runNotices: readonly LocalNotice[],
): { readonly rows: readonly TranscriptRow[]; readonly settledRows: number } {
  const rows = run?.transcript.rows ?? [];
  const settledRows = run?.transcript.settledRows ?? 0;
  if (runNotices.length === 0) return { rows, settledRows };
  const settledSeq = settledRows === 0 ? 0 : rowSeq(rows[settledRows - 1]);
  const out: TranscriptRow[] = [];
  let next = 0;
  const flushThrough = (seq: number): void => {
    while (next < rows.length && rowSeq(rows[next]) <= seq) {
      out.push(rows[next]!);
      next += 1;
    }
  };
  for (const notice of runNotices.toSorted((a, b) => a.afterSeq - b.afterSeq)) {
    flushThrough(notice.afterSeq);
    out.push({
      ...notice.row,
      seqNo: notice.afterSeq,
      settlementSeqNo: notice.afterSeq,
    });
  }
  for (; next < rows.length; next += 1) out.push(rows[next]!);
  return {
    rows: out,
    settledRows:
      settledRows +
      runNotices.filter((notice) => notice.afterSeq <= settledSeq).length,
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
  const message = toErrorMessage(Cause.squash(cause));
  return Effect.logError(`Runtime request failed: ${message}`).pipe(
    withLogChannel(CHANNEL),
    Effect.as(`The request failed inside TeXRA: ${message}`),
  );
}

registerCliStateResetHook(() => {
  localEntrySeq = 0;
  notices.set([]);
});
