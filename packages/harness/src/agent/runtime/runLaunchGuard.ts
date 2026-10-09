/**
 * The ends a run's lifecycle does not write. The terminal a run's launch
 * owns: the backstop `run.end`, the host's final artifacts and the claim. A
 * fresh root (`runAgent`), a standalone resume and a detached child's handoff
 * end through {@link runWithLaunchGuard}; a child loop's own tail writes the
 * same backstop row. And a child parked holding its result for a parent
 * another process held: whoever next admits the parent delivers it and
 * ends the child (`deliverHeld`), the "ownerless stop" end site.
 */
import { Cause, Effect, Exit, Schedule, type Scope } from 'effect';

import { classifyAgentError } from '@common/errors';
import { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
import {
  aggregateId,
  aggregateTarget,
  emptyRunEndOutput,
  RUN_OUTCOME,
  RUN_SUBSTATE,
  storedRunOutput,
  type RunId,
  type RunOutcome,
  type SessionEvent,
  type SessionEventDraft,
} from '@shared/schemas';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import type { Append } from '@shared/session/sessionEvents';
import { aggregateError } from '@utils/core';
import { ensureError } from '@utils/errors/errorMessage';

import { parentAdmission, warn, type TransactionPart } from './childSettlement';
import { consumedRows, haltedPositionRow } from './loop/rows';
import { presentRunFailure } from './terminalResultToast';
import type { SessionHandle } from './SessionHandle';

/**
 * End a run its lifecycle did not end: the one backstop writer of `run.end`
 * beside the lifecycle's own terminal. An outcome the lifecycle already wrote
 * stands (`keepExistingOutcome`), so a row lands only for a run that failed
 * or stopped before its lifecycle, or outside it; a failure carries its
 * classified error, and a child's last-turn `settlement` rides the row.
 */
export const endRunOutsideLifecycle = (
  session: SessionHandle,
  runId: RunId,
  outcome: RunOutcome,
  error: unknown,
  settlement?: TransactionPart,
): Effect.Effect<void, Error> =>
  session.runs
    .end({
      runId,
      outcome,
      keepExistingOutcome: true,
      ...(settlement !== undefined && { settlement }),
      ...(outcome === RUN_OUTCOME.FAILED && error != null
        ? {
            error: {
              kind: classifyAgentError(error),
              message: getSdkErrorMessage(error),
            },
          }
        : {}),
    })
    .pipe(
      Effect.flatMap((finalized) =>
        finalized.ok ? Effect.void : Effect.fail(ensureError(finalized.error)),
      ),
    );

/** A launch that owns its run for the run's whole life. */
export interface RunTerminalOwner {
  /** Fires once the launch holds the run's claim. */
  readonly onRunClaimed?: (runId: RunId) => void;
  /**
   * Host-owned final state, persisted before the run's claim goes. Its
   * failure is one more failure reported.
   */
  readonly beforeRunEnd?: (
    session: SessionHandle,
  ) => Effect.Effect<void, Error>;
}

/**
 * The one terminal of a run's launch, in the exit-protocol pattern: a stop
 * lands before it or after it, never inside. It ends what the lifecycle did
 * not ({@link endRunOutsideLifecycle}: FAILED, or CANCELLED for a stop),
 * persists the host's final artifacts, then lets the claim go.
 *
 * With an `owner`, the launch owns the run for its whole life (a fresh root,
 * a standalone resume): the guard holds the run's claim around `operation`
 * and ends the run on every exit once that hold is taken; a refused hold
 * fails as itself. Without one, `operation` only hands an admitted child to
 * its loop, which owns the ending from there: the guard ends the run when the
 * handoff fails and releases the birth claim no driver took.
 *
 * The terminal's failures replace the operation's own as one aggregate; an
 * interruption unwinds as itself.
 */
export function runWithLaunchGuard<A, E, R>(
  session: SessionHandle,
  runId: RunId,
  operation: Effect.Effect<A, E, R>,
  owner?: RunTerminalOwner,
): Effect.Effect<A, E | Error, R> {
  return Effect.suspend(() => {
    const failures: unknown[] = [];
    const collect = <X, Y>(exit: Exit.Exit<X, Y>): void => {
      if (Exit.isFailure(exit)) failures.push(Cause.squash(exit.cause));
    };
    const terminal = (exit: Exit.Exit<A, E>) =>
      Effect.gen(function* () {
        if (Exit.isFailure(exit)) {
          const stopped = Cause.hasInterrupts(exit.cause);
          collect(
            yield* Effect.exit(
              endRunOutsideLifecycle(
                session,
                runId,
                stopped ? RUN_OUTCOME.CANCELLED : RUN_OUTCOME.FAILED,
                Cause.squash(exit.cause),
              ),
            ),
          );
        }
        collect(
          yield* Effect.exit(
            Effect.suspend(() => owner?.beforeRunEnd?.(session) ?? Effect.void),
          ),
        );
        // A hold taken and let go at once releases the birth claim no driver
        // took; an owner's own hold is released by its scope.
        if (owner === undefined)
          yield* Effect.scoped(
            Effect.ignore(session.log.hold(runId, { ends: true })),
          );
      }).pipe(Effect.uninterruptible);
    const guarded: Effect.Effect<A, E | Error, R> =
      owner === undefined
        ? operation.pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) ? Effect.void : terminal(exit),
            ),
          )
        : // No interrupt lands between taking the hold and attaching the
          // terminal, so a claimed run always gets its ending; a refused hold
          // still fails as itself.
          Effect.scoped(
            Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                yield* session.log.hold(runId, { ends: true });
                owner.onRunClaimed?.(runId);
                return yield* restore(operation).pipe(Effect.onExit(terminal));
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
export const deliverHeld = (
  session: SessionHandle,
  parent: RunId,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    // The listing as the log holds it: a session just opened has not folded it.
    const { runs } = yield* session.view.read([]);
    for (const child of runs.values())
      if (child.parentId === parent && !isTerminalOutcomePhase(child.status))
        yield* Effect.flatten(
          session.log.transact((tx) =>
            deliverOne(session, tx.append, child.id, parent).pipe(
              Effect.scoped,
            ),
          ),
        );
  });

/** The child's parks in its current lifecycle, each held one with the
 *  report its turn settled with just before it; none once it ended. */
const heldParks = (rows: readonly SessionEvent[]) => {
  const since = rows.findLast(
    (row) => row.type === 'run.end' || row.type === 'run.activate',
  );
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
 *  its end when the newest park held its last turn; returns what to say
 *  once they commit. */
const deliverOne = (
  session: SessionHandle,
  append: Append,
  child: RunId,
  parent: RunId,
): Effect.Effect<Effect.Effect<void>, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const rows = yield* session.log.rows(aggregateId('run', child), [
      'child.park',
      'run.end',
      'run.activate',
      'run.report',
      'run.position',
    ]);
    const parks = heldParks(rows);
    const held = parks.filter(({ park }) => park.heldFor !== undefined);
    if (held.length === 0) return Effect.void;
    const ends = parks.at(-1)?.park.ends;
    if (ends !== undefined) yield* session.log.hold(child);
    const admitted = [];
    for (const { park, text } of held) {
      const from = { kind: 'run', runId: child } as const;
      const one = yield* parentAdmission(
        session.followUps,
        parent,
        { text, from, deliveryId: park.heldFor },
        {},
        undefined,
      );
      const { sent } = one;
      if (sent.kind === 'refused' && sent.reason === 'owned_elsewhere')
        return Effect.void;
      admitted.push(one);
    }
    const end =
      ends === undefined ? [] : yield* endRows(session, child, ends, rows);
    yield* append([...admitted.flatMap((one) => one.rows), ...end]);
    return Effect.all(
      admitted.map((one) => one.committed),
      { discard: true },
    );
  });

/** A held child's end, as the normal end writes it: its unread input
 *  consumed, its halt, what it left open, and its `run.end`. */
const endRows = (
  session: SessionHandle,
  child: RunId,
  end: 'completed' | 'failed',
  rows: readonly SessionEvent[],
): Effect.Effect<readonly SessionEventDraft[], Error> =>
  Effect.map(session.followUps.read(child), ({ followUps }) => {
    const position = rows.findLast((row) => row.type === 'run.position');
    return [
      ...consumedRows(child, followUps),
      ...(position?.type === 'run.position'
        ? [haltedPositionRow(position, end)]
        : []),
      ...session.trace.closure(child, end),
      {
        type: 'run.end',
        aggregateId: aggregateId('run', child),
        outcome: end,
        output: storedRunOutput(emptyRunEndOutput()),
      },
    ];
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
        const rows = yield* session.log.rows(aggregateId('run', child), [
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
