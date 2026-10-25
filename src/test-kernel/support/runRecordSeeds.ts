/**
 * Seed a run's record rows as production commits them: `run.config` through
 * registration (`runLifecycle`), `run.report` through child delivery, the
 * workspace files a run edited through its settled calls. Suites that start
 * from a stored run commit the row directly instead.
 */
import { randomUUID } from 'node:crypto';

import { Effect, Schema } from 'effect';

import { appendRow, positionRow, rowAggregate } from '@agent/runtime/loop/rows';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { RunRecord } from '@agent/core/definition/RunRecord';
import { freshRunState } from '@shared/session/runState';
import {
  qualifyAggregateId,
  RunRecordFieldsSchema,
  type RunId,
} from '@shared/schemas';
import { seedRows } from './sessionTestUtils';

export const seedRunRecord = (
  session: SessionHandle,
  runId: RunId,
  record: RunRecord,
) =>
  Effect.suspend(() =>
    seedRows(session.log)([
      {
        type: 'run.config',
        aggregateId: qualifyAggregateId('run', runId),
        config: Schema.decodeUnknownSync(RunRecordFieldsSchema)(record),
      },
    ]),
  ).pipe(Effect.asVoid);

export const seedReport = (
  session: SessionHandle,
  runId: RunId,
  report: string,
) =>
  session.log
    .transact([
      {
        type: 'run.report',
        aggregateId: qualifyAggregateId('run', runId),
        report,
      },
    ])
    .pipe(Effect.asVoid);

/** The run's history as a run that edited `paths` leaves it: one
 *  handed-down call whose executed settlement records the edits, the facts
 *  `readWorkspaceFiles` folds. */
export const seedEditedFiles = (
  session: SessionHandle,
  runId: RunId,
  paths: readonly string[],
) =>
  Effect.gen(function* () {
    const cell = yield* session.runHistory.open(runId, {
      activation: () => Effect.succeed([]),
    });
    const responseId = randomUUID();
    const callId = 'edit';
    yield* cell.append([
      appendRow(runId, [
        { role: 'user', content: [{ kind: 'text', text: 'edit' }] },
      ]),
      positionRow(runId, freshRunState(0), 'turn.ready'),
      {
        type: 'model.message',
        aggregateId: rowAggregate(runId),
        payload: {
          kind: 'handed-down',
          responseId,
          call: {
            callId,
            toolName: 'write_file',
            lane: 'barrier',
            replay: 'unsafe',
            duplicateOf: null,
            logId: callId,
          },
          argumentsText: '{}',
        },
      },
      {
        type: 'tool.result',
        aggregateId: rowAggregate(runId),
        payload: {
          responseId,
          callId,
          attempt: 1,
          disposition: 'executed',
          duplicateOf: null,
          result: {
            status: 'executed',
            output: 'written',
            edits: paths.map((path) => ({ path })),
          },
          attachments: [],
        },
      },
    ]);
  });
