/**
 * The ends a run's driver does not write (a failed process-child handoff;
 * a held child's end, delivered by whoever next admits its parent:
 * `deliverHeld`), and the terminal a run's launch owns: the host's final
 * artifacts and the claim.
 */
import { Cause, Effect, Exit, Schedule, type Scope } from 'effect';

import { endIn, finalizeRun } from '@agent/storage/runLifecycle';
import { getRunRecords } from '@agent/storage/runRecords';
import { classifyAgentError } from '@common/errors/agentErrorClassification';
import { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
import {
  qualifyAggregateId,
  aggregateTarget,
  RUN_OUTCOME,
  RUN_SUBSTATE,
  type RunId,
  type RunOutcome,
  type SessionEvent,
} from '@shared/schemas';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import { heldElsewhereBy } from '@shared/session/database';
import { lastLifecycleRow } from '@shared/session/runFacts';
import type { Append } from '@shared/session/sessionEvents';
import { aggregateError } from '@utils/core';
import { ensureError } from '@utils/errors/errorMessage';

import { parentAdmission, warn, type TransactionPart } from './childTurnResult';
import { presentRunFailure } from './terminalResultToast';
import type { SessionHandle } from './SessionHandle';

/**
 * End a run no driver ends: the one writer of an ownerless `run.end` (a
 * stop that reached no live target, a process child whose handoff failed,
 * a native child's loop that outlived its lifecycle, a session close). An
 * outcome the run already wrote stands (`keepExistingOutcome`), so a row
 * lands only for a run that failed or stopped outside its driver; a failure
 * carries its classified error, and a child's `lastTurn` result commits
 * with the row.
 */
export const endRunOutsideLifecycle = (
  session: SessionHandle,
  runId: RunId,
  outcome: RunOutcome,
  error: unknown,
  lastTurn?: TransactionPart,
): Effect.Effect<void, Error> =>
  finalizeRun(session, {
    runId,
    outcome,
    keepExistingOutcome: true,
    ...(lastTurn !== undefined && { lastTurn }),
    ...(outcome === RUN_OUTCOME.FAILED && error != null
      ? {
          error: {
            kind: classifyAgentError(error),
            message: getSdkErrorMessage(error),
          },
        }
      : {}),
  }).pipe(Effect.asVoid);

/**
 * Let go of `runId`'s claim where no hold of this process keeps it (a
 * birth's): a hold taken and let go at once. A run never born has none.
 */
export const letGoOfClaim = (
  session: SessionHandle,
  runId: RunId,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    // A run never born has no claim to let go.
    if (!(yield* getRunRecords(session, runId).exists())) return;
    yield* Effect.scoped(session.log.hold(runId, { ends: true }));
  }).pipe(
    Effect.catch((error) =>
      warn(undefined, `The claim on ${runId} was not let go.`, error),
    ),
  );

/**
 * The one terminal of a run's launch, in the exit-protocol pattern: a stop
 * lands before it or after it, never inside. It lets the claim go.
 *
 * When `owned`, the launch owns the run for its whole life (a fresh root,
 * a standalone resume): a run that already exists (a resume) has its claim
 * held around `operation`, so no other owner moves it between the resume's
 * read and its launch; a fresh run is born with its claim at its opening.
 * Otherwise `operation` only hands a registered child to its loop,
 * which owns the ending from there: the guard ends the run when the
 * handoff fails ({@link endRunOutsideLifecycle}). Either way a claim no hold
 * here took (a birth's) is let go once the operation is done; a loop still
 * holding its own keeps it.
 *
 * The terminal's failures replace the operation's own as one aggregate; an
 * interruption unwinds as itself.
 */
export function runWithLaunchGuard<A, E, R>(
  session: SessionHandle,
  runId: RunId,
  operation: Effect.Effect<A, E, R>,
  owned = false,
): Effect.Effect<A, E | Error, R> {
  return Effect.suspend(() => {
    const failures: unknown[] = [];
    const collect = <X, Y>(exit: Exit.Exit<X, Y>): void => {
      if (Exit.isFailure(exit)) failures.push(Cause.squash(exit.cause));
    };
    const terminal = (held: boolean) => (exit: Exit.Exit<A, E>) =>
      Effect.gen(function* () {
        if (!owned && Exit.isFailure(exit))
          collect(
            yield* Effect.exit(
              endRunOutsideLifecycle(
                session,
                runId,
                Cause.hasInterrupts(exit.cause)
                  ? RUN_OUTCOME.CANCELLED
                  : RUN_OUTCOME.FAILED,
                Cause.squash(exit.cause),
              ),
            ),
          );
        if (!held) yield* letGoOfClaim(session, runId);
      }).pipe(Effect.uninterruptible);
    const guarded: Effect.Effect<A, E | Error, R> = !owned
      ? operation.pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) ? Effect.void : terminal(false)(exit),
          ),
        )
      : // No interrupt lands between taking the hold and attaching the
        // terminal, so a held run always gets its terminal; a refused
        // hold still fails as itself.
        Effect.scoped(
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const held = yield* getRunRecords(session, runId).exists();
              if (held) yield* session.log.hold(runId, { ends: true });
              return yield* restore(operation).pipe(
                Effect.onExit(terminal(held)),
              );
            }),
          ),
        );
    return Effect.exit(guarded).pipe(
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

/** The child's parks in its current lifecycle, each held one with the
 *  report its turn settled with just before it; none once it ended. */
const heldParks = (rows: readonly SessionEvent[], child: RunId) => {
  const since = lastLifecycleRow(rows, child);
  if (since?.type === 'run.end') return [];
  return rows.flatMap((park) => {
    if (park.type !== 'child.park' || park.commit <= (since?.commit ?? 0))
      return [];
    const report = rows.findLast(
      (row) => row.type === 'run.report' && row.commit < park.commit,
    );
    const text = report?.type === 'run.report' ? report.report : null;
    return [{ park, text: text ?? '' }];
  });
};

/** Every result a child holds for `parent` since its lifecycle began, and
 *  its end when the newest park held its last turn. */
const deliverOne = Effect.fn('runLaunchGuard.deliverOne')(function* (
  session: SessionHandle,
  append: Append,
  child: RunId,
  parent: RunId,
): Effect.fn.Return<void, Error, Scope.Scope> {
  const rows = yield* session.log.rows(qualifyAggregateId('run', child), [
    'child.park',
    'run.end',
    'run.activate',
    'run.report',
  ]);
  const parks = heldParks(rows, child);
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
  yield* endIn(session, append, {
    runId: child,
    outcome: ends,
    lastTurn: Effect.succeed({ rows: delivered }),
  });
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
        const rows = yield* session.log.rows(qualifyAggregateId('run', child), [
          'child.park',
        ]);
        const park = rows.at(-1);
        if (park?.type !== 'child.park' || park.heldFor !== followUpId) return;
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
