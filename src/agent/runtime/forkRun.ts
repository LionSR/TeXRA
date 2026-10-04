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
import { registrationRows } from '@agent/storage/runLifecycle';
import {
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
  // Input consumed for a turn that has not run is inside that turn.
  state.at !== 'turn.ready' &&
  state.openAttempt === null &&
  state.pendingResponse === null &&
  Object.keys(state.pendingIntents).length === 0 &&
  state.pendingRetry === null &&
  Object.values(state.requests).every((request) => request.decision !== null);

const refused = (reason: string) => new Rejected({ reason });

/**
 * Fork run `from` at `at`, the `seq` of a settled position in its run
 * history, or at the end of its last completed turn when `at` is null (a
 * run in a turn now is forked from before it). Returns the new run's id;
 * the run is written whole and left for its host to resume.
 */
export const forkRun = Effect.fn('forkRun')(function* (
  session: SessionHandle,
  from: { readonly id: RunId; readonly uid: string },
  at: number | null,
): Effect.fn.Return<RunId, Rejected | Error> {
  const records = getRunRecords(session, from.id);
  const config = yield* records.readConfig();
  if (config === null || config.script != null) {
    return yield* refused('Only a conversation can be forked.');
  }
  const aggregate = aggregateId('run', from.id);
  const start = (yield* session.readRunRecords(from.id)).find(
    (row) => row.type === 'run.start',
  );
  if (start?.type !== 'run.start') {
    return yield* refused(`Task ${from.id} has no recorded start.`);
  }
  // The title the source shows: its newest user title over any later model
  // title, as the fold reads it, with its authorship.
  const titles = (yield* session.readAggregate(aggregate, [
    'run.description',
  ])).flatMap((row) => (row.type === 'run.description' ? [row] : []));
  const title =
    titles.findLast((row) => row.by === 'user') ?? titles.at(-1) ?? null;
  // The cut is a position row: a turn boundary of the source, not any seq.
  const parks = (yield* session.readAggregate(aggregate, [
    'run.position',
  ])).filter(
    (row) =>
      row.type === 'run.position' &&
      (row.payload.at === 'waiting' || row.payload.at === 'halted'),
  );
  const settledAt = (seq: number) =>
    Effect.map(session.runHistory.load(from.id, seq), (state) =>
      state !== null && state.loop !== null && isSettled(state)
        ? { seq, state, loop: state.loop }
        : null,
    );
  let found: Effect.Success<ReturnType<typeof settledAt>> = null;
  if (at !== null) {
    if (parks.some((park) => park.seq === at)) found = yield* settledAt(at);
  } else {
    // The latest turn boundary whose state is settled: the last park of a
    // conversation, or the one before the turn it is in now.
    for (const park of parks.toReversed()) {
      found = yield* settledAt(park.seq);
      if (found !== null) break;
    }
  }
  if (found === null) {
    return yield* refused(
      'A fork starts at a settled point of a conversation: the end of one of its turns.',
    );
  }
  const { seq: cut, state } = found;
  const runId = generateRunId();
  // The view, and the loop state a resume restores with the content it
  // names (its base system text and instruction), less the structured
  // result of a turn the fork never ran. The offered tools and the system
  // text a step adds are the fork's first step's to record, as for any run.
  const { structured: _, ...loop } = found.loop;
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
  // A child's fork is a root: the task its ancestors were given, and the
  // structured result its parent's call asked for, are not its.
  const {
    rootUserInstruction: _root,
    outputSchema: _schema,
    ...record
  } = config;
  const registration = yield* registrationRows(session, runId, record, {
    identity: start.identity,
    userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
    provenance: { kind: 'fork', from, at: cut },
    ...(title !== null && {
      description: title.description,
      descriptionBy: title.by,
    }),
  });
  // Registration and history are one commit: a fork exists with its history
  // or not at all, and unclaimed: the host's to resume, as any waiting
  // conversation is.
  yield* session.runHistory.appendBatch(runId, null, rows, registration);
  return runId;
});
