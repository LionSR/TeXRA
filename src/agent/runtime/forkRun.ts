/**
 * Fork (durable harness, gap 3): a new root run whose history is another
 * run's model view at a settled position. The new run's `run.start` names
 * where its history came from (`provenance: { kind: 'fork', from, at }`,
 * HQ4), and its first run history row is the `context.edit` that seeds that
 * view, followed by the loop state a resume restores and a `waiting`
 * position: the fork is a conversation waiting for its user's next
 * message, which any host's Resume or follow-up continues. The doc's
 * "offered system and tools" are not copied: a run's offered set is
 * recorded only where a step opens, so the fork's first step records its
 * own. Nothing pending is copied (no follow-up, request or retry permit),
 * its usage starts at zero, and the source's plugin facts stay with the
 * source, so a goal it ran is not the fork's.
 */
import { Effect } from 'effect';

import { getRunRecords } from '@agent/storage/runRecords';
import { registerRun } from '@agent/storage/runLifecycle';
import {
  AgentCategory,
  aggregateId,
  USER_FOLLOW_UP_SUPPORT,
  type RunId,
} from '@shared/schemas';
import { Rejected } from '@shared/session/requestErrors';
import type { RunHistoryDraft, RunState } from '@shared/session/runStateFold';
import { generateRunId } from '@utils/core';

import { positionRow, rowAggregate, snapshotRow } from './loop/rows';
import type { SessionHandle } from './SessionHandle';

/**
 * Whether the run stands at a settled position (HQ4): at a turn boundary,
 * with no open attempt, response, tool intent, undecided request or retry
 * permit. A cut anywhere else would carry a result nobody produced.
 */
const isSettled = (state: RunState): boolean =>
  (state.phase === 'waiting' || state.phase === 'halted') &&
  state.openAttempt === null &&
  state.pendingResponse === null &&
  Object.keys(state.pendingIntents).length === 0 &&
  state.pendingRetry === null &&
  Object.values(state.requests).every((request) => request.decision !== null);

const refused = (reason: string) => new Rejected({ reason });

/**
 * Fork run `from` at `at`, the `seq` of a settled position in its run
 * history, or at its latest position when `at` is null. Returns the new
 * run's id; the run is written whole and left for its host to resume.
 */
export const forkRun = Effect.fn('forkRun')(function* (
  session: SessionHandle,
  from: { readonly id: RunId; readonly uid: string },
  at: number | null,
): Effect.fn.Return<RunId, Rejected | Error> {
  const records = getRunRecords(session, from.id);
  const config = yield* records.readConfig();
  if (
    config === null ||
    config.agentCategory !== AgentCategory.ToolUse ||
    config.backgroundScript != null
  ) {
    return yield* refused('Only a conversation can be forked.');
  }
  const latest = yield* session.readRunRecords(from.id);
  const start = latest.find((row) => row.type === 'run.start');
  const title = latest.findLast((row) => row.type === 'run.description');
  if (start?.type !== 'run.start') {
    return yield* refused(`Task ${from.id} has no recorded start.`);
  }
  // The latest position, when none is named: the end of the conversation.
  const cut =
    at ??
    (yield* session.readAggregate(aggregateId('run', from.id), [
      'run.position',
    ])).at(-1)?.seq;
  if (cut === undefined) {
    return yield* refused(`Task ${from.id} has no position to fork from.`);
  }
  const state = yield* session.runHistory.load(from.id, cut);
  if (state === null || state.loop === null || !isSettled(state)) {
    return yield* refused(
      'A fork starts at a settled point of a conversation: the end of one of its turns.',
    );
  }
  const runId = generateRunId();
  // The view, and the loop state a resume restores with the content it
  // names (its base system text and instruction), less the structured
  // result of a turn the fork never ran. The offered tools and the system
  // text a step adds are the fork's first step's to record, as for any run.
  const { structured: _, ...loop } = state.loop;
  const named = [loop.system, loop.instruction].flatMap((digest) =>
    digest === undefined ? [] : [digest],
  );
  const rows: RunHistoryDraft[] = [
    {
      type: 'context.edit',
      aggregateId: rowAggregate(runId),
      payload: {
        cause: 'fork',
        trigger: null,
        base: null,
        range: { from: 0, to: 0 },
        messages: state.messages,
        usage: null,
      },
    },
    ...named.map((digest): RunHistoryDraft => ({
      type: 'context.blob',
      aggregateId: rowAggregate(runId),
      payload: { digest, value: state.contents[digest] },
    })),
    ...snapshotRow(
      runId,
      { ...state, lastSnapshot: null },
      { runtime: { lastError: null }, state: loop },
    ),
    positionRow(runId, state, 'waiting'),
  ];
  yield* registerRun(session, runId, config, {
    identity: start.identity,
    userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
    provenance: { kind: 'fork', from, at: cut },
    ...(title?.type === 'run.description' && {
      description: title.description,
    }),
  });
  // The registration's claim, ended once the history is written: the fork
  // is the host's to resume, as any waiting conversation is.
  yield* Effect.scoped(
    session
      .holdRunClaim(runId)
      .pipe(Effect.andThen(session.runHistory.appendBatch(runId, null, rows))),
  );
  return runId;
});
