/**
 * Seed a run's record rows as production commits them: `run.config` through
 * registration (`runLifecycle`), `run.report` through child delivery. Suites
 * that start from a stored run commit the row directly instead.
 */
import { Effect } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  RunRecordSchema,
  type RunRecord,
} from '@agent/core/definition/RunRecord';
import { aggregateId, type RunId } from '@shared/schemas';

export const seedRunRecord = (
  session: SessionHandle,
  runId: RunId,
  record: RunRecord,
) =>
  Effect.suspend(() =>
    session.commit([
      {
        type: 'run.config',
        aggregateId: aggregateId('run', runId),
        config: RunRecordSchema.parse(record),
      },
    ]),
  ).pipe(Effect.asVoid);

export const seedReport = (
  session: SessionHandle,
  runId: RunId,
  report: string,
) =>
  session
    .commit([
      { type: 'run.report', aggregateId: aggregateId('run', runId), report },
    ])
    .pipe(Effect.asVoid);
