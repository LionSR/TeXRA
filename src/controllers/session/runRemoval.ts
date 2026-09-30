/**
 * A run leaving the listing, for the requests that ask it to: to the Trash
 * and back (`run.trash`), or for good (`run.delete`, and the listing-driven
 * removal of `SessionRequests.removeRun`).
 */
import { Effect, type Context } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { RunLive, Runs } from '@agent/runtime/runRegistry';
import { aggregateId as qualifyAggregateId, type RunId } from '@shared/schemas';
import {
  DatabaseClaimRefused,
  DatabaseNotOwner,
  DatabaseWriteFailed,
  type AggregateState,
  type Database,
  type DeletionMode,
} from '@shared/session/database';
import {
  NotOwner,
  Rejected,
  Unavailable,
  type RequestError,
} from '@shared/session/requestErrors';
import type { Outcome } from '@shared/session/runtimeRequest';
import type { SessionEventsShape } from '@shared/session/sessionEvents';
import { toErrorMessage } from '@utils/errors/errorMessage';

/** The log's reads, and removal through the session's publisher. */
export type SessionRequestLog = Pick<
  Context.Service.Shape<typeof Database>,
  'aggregateState' | 'readAll'
> &
  Pick<SessionEventsShape, 'removeRun'>;

/** Delete the admitted lifetime after acquiring its inactive run slot. */
export function deleteAdmittedRun(
  log: SessionRequestLog,
  runId: RunId,
  admitted: AggregateState,
  mode: DeletionMode,
): Effect.Effect<Outcome, RequestError, Runs> {
  const aggregateId = qualifyAggregateId('run', runId);
  return Effect.gen(function* () {
    if (admitted.startCommit === null) {
      return yield* Effect.fail(
        new Unavailable({
          runId,
          reason: 'The run has no recorded start.',
        }),
      );
    }
    const [start] = yield* log
      .readAll(admitted.startCommit - 1, admitted.startCommit)
      .pipe(Effect.orDie);
    if (start?.type !== 'run.start' || start.aggregateId !== aggregateId) {
      return yield* Effect.fail(
        new Unavailable({
          runId,
          reason: 'The run start could not be read.',
        }),
      );
    }
    yield* (yield* Runs)
      .withInactiveRunStep(
        runId,
        log.removeRun(aggregateId, mode, start.commit),
      )
      .pipe(
        Effect.mapError((error): RequestError => {
          if (error instanceof RunLive)
            return new Unavailable({
              runId,
              reason: 'Stop the run before deleting it.',
            });
          if (
            error instanceof DatabaseWriteFailed &&
            error.cause instanceof DatabaseClaimRefused
          ) {
            return error.cause.verdict === 'alive'
              ? new NotOwner({ runId })
              : new Rejected({
                  reason:
                    'The current owner could not be verified, so automatic or bulk deletion was refused.',
                });
          }
          return new Unavailable({
            runId,
            reason: 'The run could not be removed from the listing.',
          });
        }),
      );
    return { kind: 'deleted' as const, result: 'deleted' as const };
  });
}

/**
 * Commit the run's `run.trash` under an inactive hold: the registry refuses
 * a run that started since the view offered the action, and the hold's
 * claim keeps another process from taking it meanwhile.
 */
export function setTrashed(
  session: Pick<SessionHandle, 'commit'>,
  runId: RunId,
  trashed: boolean,
): Effect.Effect<Outcome, RequestError, Runs> {
  const aggregateId = qualifyAggregateId('run', runId);
  return Effect.flatMap(Runs, (runs) =>
    Effect.scoped(
      runs
        .holdInactiveRun(runId)
        .pipe(
          Effect.andThen(
            session.commit([{ type: 'run.trash', aggregateId, trashed }]),
          ),
        ),
    ),
  ).pipe(
    Effect.mapError((error): RequestError => {
      if (error instanceof RunLive)
        return new Unavailable({ runId, reason: 'Stop the run first.' });
      if (error instanceof DatabaseNotOwner) return new NotOwner({ runId });
      return new Unavailable({
        runId,
        reason: `The run could not be ${trashed ? 'moved to' : 'restored from'} the Trash: ${toErrorMessage(error)}`,
      });
    }),
    Effect.as({ kind: 'done' } as const),
  );
}
