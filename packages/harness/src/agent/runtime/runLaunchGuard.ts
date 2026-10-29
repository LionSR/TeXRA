/**
 * The ends a run's driver does not write: a failed process-child hand-off,
 * and a held child's end, delivered by whoever next admits its parent
 * (`deliverHeld`). A run's claim is its generation's (`RunRegistry.admit`).
 */
import { Cause, Effect, Exit, Schedule, type Scope } from 'effect';

import { endIn, finalizeRun } from '@agent/storage/runLifecycle';
import { classifyAgentError } from '@common/errors/agentErrorClassification';
import { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
import {
  qualifyAggregateId,
  aggregateTarget,
  RUN_OUTCOME,
  RUN_SUBSTATE,
  type RunId,
  type SessionEvent,
} from '@shared/schemas';
import {
  isTerminalOutcomePhase,
  outcomeFromCause,
} from '@shared/runs/runStatus';
import { heldElsewhereBy } from '@shared/session/database';
import { RUN_ROW_READS, runRowsFrom } from '@shared/session/runRows';
import type { Append } from '@shared/session/sessionEvents';
import { aggregateError } from '@utils/core';
import { ensureError } from '@utils/errors/errorMessage';

import { parentAdmission, warn } from './childTurnResult';
import { presentRunFailure } from './terminalResultToast';
import type { SessionHandle } from './SessionHandle';

/**
 * Hand a registered process child to its loop, which owns its end from
 * there. A hand-off that fails ends the run ownerless (an end the run
 * already wrote stands), with its classified error, which lets its birth's
 * claim go. The ending's failures join the hand-off's own as one
 * aggregate; an interruption unwinds as itself.
 */
export function runWithLaunchGuard<A, E, R>(
  session: SessionHandle,
  runId: RunId,
  operation: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Error, R> {
  return Effect.suspend(() => {
    const failures: unknown[] = [];
    const handedOff = operation.pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Effect.gen(function* () {
              const outcome = outcomeFromCause(exit.cause);
              const error = Cause.squash(exit.cause);
              const end = yield* Effect.exit(
                finalizeRun(session, {
                  runId,
                  outcome,
                  ownerless: true,
                  stopped: outcome === RUN_OUTCOME.CANCELLED,
                  ...(outcome === RUN_OUTCOME.FAILED && {
                    error: {
                      kind: classifyAgentError(error),
                      message: getSdkErrorMessage(error),
                    },
                  }),
                }),
              );
              if (Exit.isFailure(end)) failures.push(Cause.squash(end.cause));
            }),
      ),
    );
    return Effect.exit(handedOff).pipe(
      Effect.flatMap((exit) => {
        if (
          failures.length === 0 ||
          (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
        )
          return exit;
        const message = `Run ${runId} failed or its ending could not be persisted`;
        // A stop that carried a defect keeps both; the ending's failures join.
        if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause))
          return Effect.failCause(
            Cause.combine(
              exit.cause,
              Cause.fail(ensureError(aggregateError(failures, message))),
            ),
          );
        if (Exit.isFailure(exit)) failures.unshift(Cause.squash(exit.cause));
        return Effect.fail(ensureError(aggregateError(failures, message)));
      }),
    );
  });
}

/**
 * Deliver what `parent`'s children hold for it (`child.park` `heldFor`),
 * read from rows, each child in one append; a last turn held (`ends`) also
 * ends the child, under its claim. Run by whoever holds the parent: its
 * tail seeing a park, and its resume. A parent another process holds keeps
 * it held; a replay writes nothing, so two triggers deliver once.
 */
export const deliverHeld = Effect.fn('runLaunchGuard.deliverHeld')(function* (
  session: SessionHandle,
  parent: RunId,
): Effect.fn.Return<void, Error> {
  // The listing as the log holds it: a session just opened has not folded it.
  const { runs } = yield* session.view.read([]);
  for (const child of runs.values())
    if (child.parentId === parent && !isTerminalOutcomePhase(child.status))
      yield* session.log.transact((tx) =>
        deliverOne(session, tx.append, child.id, parent).pipe(Effect.scoped),
      );
});

/** The child's parks in its current lifecycle (`RunRows.heldParks`), each
 *  with the report its turn settled with just before it; none once it
 *  ended. */
const heldParks = (session: SessionHandle, child: RunId) =>
  Effect.map(
    session.log.rows(qualifyAggregateId('run', child), RUN_ROW_READS.parks),
    (rows) => runRowsFrom(rows).heldParks,
  );

/** Every result a child holds for `parent` since its lifecycle began, and
 *  its end when the newest park held its last turn. */
const deliverOne = Effect.fn('runLaunchGuard.deliverOne')(function* (
  session: SessionHandle,
  append: Append,
  child: RunId,
  parent: RunId,
): Effect.fn.Return<void, Error, Scope.Scope> {
  const parks = yield* heldParks(session, child);
  const held = parks.filter(({ park }) => park.heldFor !== undefined);
  if (held.length === 0) return;
  const ends = parks.at(-1)?.park.ends;
  // The child's claim, held here or taken from an owner that died, lets
  // this append also end the child or clear its waiting park. A live
  // owner elsewhere keeps the claim and clears the park itself when it
  // sees the delivery (`clearHeld`).
  const holdsChild = yield* session.log.hold(child).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      ends === undefined && heldElsewhereBy(error) !== null
        ? Effect.succeed(false)
        : Effect.fail(error),
    ),
  );
  const from = { kind: 'run', runId: child } as const;
  const delivered = [];
  let refused = false;
  for (const { park, text } of held) {
    const one = yield* parentAdmission(
      session,
      parent,
      { text, from, deliveryId: park.heldFor },
      {},
      undefined,
    );
    if (one.sent.kind === 'refused' && one.sent.reason === 'owned_elsewhere')
      return;
    // A parent that refused it (its input closed) leaves the park held.
    if (one.sent.kind === 'refused') refused = true;
    delivered.push(...one.rows);
  }
  if (ends === undefined) {
    // Only while the newest park still reads as waiting: a replay of a
    // cleared child writes nothing.
    const clear =
      holdsChild && !refused && parks.at(-1)?.park.heldFor !== undefined
        ? [
            {
              type: 'child.park',
              aggregateId: qualifyAggregateId('run', child),
              phase: 'parked',
            } as const,
          ]
        : [];
    yield* append([...delivered, ...clear]);
    return;
  }
  // The held last turn ends the child, through its cell, in this append:
  // its unread input consumed, its halt, what it left open, its `run.end`.
  yield* endIn(
    session,
    append,
    { runId: child, outcome: ends },
    Effect.succeed({ rows: delivered }),
  );
});

/**
 * The tail's triggers, each in `scope`. A result parked for a parent this
 * process holds is delivered, retried while the child's process lets its
 * claim go, and a delivery that still fails is surfaced. A delivered
 * result a child this process runs was holding clears its waiting park.
 */
export const onHeldResult = (
  session: SessionHandle,
  event: SessionEvent,
  scope: Scope.Scope,
): Effect.Effect<unknown> => {
  const target = aggregateTarget(event.aggregateId);
  if (target.kind !== 'run') return Effect.void;
  if (event.type === 'followup.queued' && event.content.from.kind === 'run') {
    const child = event.content.from.runId;
    if (session.view.run(child)?.substate !== RUN_SUBSTATE.RESULT_WAITING)
      return Effect.void;
    return Effect.forkIn(clearHeld(session, child, event.followUpId), scope);
  }
  if (event.type !== 'child.park' || event.heldFor === undefined)
    return Effect.void;
  const parent = session.view.run(target.id)?.parentId;
  if (parent == null) return Effect.void;
  return Effect.gen(function* () {
    if (!(yield* session.log.owns(parent))) return;
    yield* deliverHeld(session, parent).pipe(
      Effect.retry({ times: 20, schedule: Schedule.spaced('500 millis') }),
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.andThen(
        warn(
          undefined,
          `Held results for ${parent} were not delivered.`,
          error,
        ),
        presentRunFailure(
          session.interactions,
          error,
          "A subagent's result could not be delivered: ",
        ),
      ),
    ),
    Effect.forkIn(scope),
  );
};

/** A child this process runs, whose held result `followUpId` was just
 *  delivered, parks plainly again: the card stops reading it as waiting. */
const clearHeld = (
  session: SessionHandle,
  child: RunId,
  followUpId: string,
): Effect.Effect<void> =>
  session.log
    .transact((tx) =>
      Effect.gen(function* () {
        if (!(yield* session.log.owns(child))) return;
        const park = (yield* heldParks(session, child)).at(-1)?.park;
        if (park === undefined || park.heldFor !== followUpId) return;
        yield* tx.append([
          {
            type: 'child.park',
            aggregateId: park.aggregateId,
            phase: 'parked',
          },
        ]);
      }),
    )
    .pipe(
      Effect.catch((error) =>
        warn(undefined, `Run ${child} still reads as holding a result.`, error),
      ),
    );
