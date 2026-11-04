/**
 * The ends a run's driver does not write: a failed process-child hand-off,
 * a held child's end, delivered by whoever next admits its parent
 * (`deliverHeld`), and what a dead process or a clean close left under a
 * run or detached from one (`closeLeftoverRun`). A run's claim is its
 * generation's (`RunRegistry.admit`).
 */
import { Cause, Context, Effect, Exit, type Scope } from 'effect';

import { openResume } from '@agent/followUp/ToolUseFollowUp';
import { runRejection } from '@agent/storage/resumability';
import {
  endIn,
  endServices,
  finalizeRun,
  type EndServices,
} from '@agent/storage/runLifecycle';
import { owningCall } from '@agent/storage/runRecords';
import { classifyAgentError } from '@common/errors/agentErrorClassification';
import { DELIVERY_TAG } from '@shared/deliveryTags';
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
import { recordOf } from '@shared/session/runRowReads';
import type { RunRows } from '@shared/session/runRowsShape';
import type { RunView } from '@shared/session/sessionView';
import { SessionViewAccess, SessionLog } from '@shared/session/runHistory';
import type { SessionTransaction } from '@shared/session/sessionLog';
import { aggregateError } from '@utils/core';
import { ensureError } from '@utils/errors/errorMessage';

import {
  childTurnResult,
  parentAdmission,
  sendToParent,
  turnResultPart,
  warn,
} from './childTurnResult';
import { formatDelivery } from './deliveryEnvelope';
import { Interactions, presentRunFailure } from './HostInteractions';
import { Runs } from './runRegistry';
import type { SessionServices } from './rootLaunch';

/**
 * Hand a registered process child to its loop, which owns its end from
 * there. A hand-off that fails ends the run ownerless (an end the run
 * already wrote stands), with its classified error, which lets its birth's
 * claim go. The ending's failures join the hand-off's own as one
 * aggregate; an interruption unwinds as itself.
 */
export function runWithLaunchGuard<A, E, R>(
  runId: RunId,
  operation: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Error, R | SessionServices> {
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
                finalizeRun({
                  runId,
                  outcome,
                  ownerless: true,
                  ...(outcome === RUN_OUTCOME.FAILED && {
                    error: classifyAgentError(error),
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
 * ends the child, under the claim its park let go (`endIn`). Run by whoever
 * holds the parent: its tail seeing a park, and its resume. A parent
 * another process holds keeps it held; a replay writes nothing, so two
 * triggers deliver once.
 */
export const deliverHeld = Effect.fn('runLaunchGuard.deliverHeld')(function* (
  parent: RunId,
): Effect.fn.Return<void, Error, SessionServices> {
  const services = yield* endServices;
  // The listing as the log holds it: a session just opened has not folded it.
  const { runs } = yield* (yield* SessionViewAccess).read([]);
  for (const child of runs.values())
    if (child.parentId === parent && !isTerminalOutcomePhase(child.status))
      yield* Context.get(services, SessionLog).transact((tx) =>
        deliverOne(tx, child.id, parent).pipe(
          Effect.scoped,
          Effect.provide(services),
        ),
      );
});

/** The child's parks in its current lifecycle (`RunRows.heldParks`), each
 *  with the report its turn settled with before it; none once it ended. */
const heldParks = (log: SessionLog['Service'], child: RunId) =>
  Effect.map(
    log.runRows(qualifyAggregateId('run', child), 'parks'),
    (rows) => rows.heldParks,
  );

/** Every result a child holds for `parent` since its lifecycle began, and
 *  its end when the newest park held its last turn. */
const deliverOne = Effect.fn('runLaunchGuard.deliverOne')(function* (
  tx: SessionTransaction,
  child: RunId,
  parent: RunId,
): Effect.fn.Return<void, Error, Scope.Scope | EndServices> {
  const { append } = tx;
  const log = yield* SessionLog;
  const parks = yield* heldParks(log, child);
  const held = parks.filter(({ park }) => park.heldFor !== undefined);
  if (held.length === 0) return;
  const ends = parks.at(-1)?.park.ends;
  // The child's claim, held here or taken from an owner that died, lets
  // this append also end the child or clear its waiting park. A live
  // owner elsewhere keeps the claim and clears the park itself when it
  // sees the delivery (`clearHeld`).
  const holdsChild = yield* log.hold(child).pipe(
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
      parent,
      { text, from, deliveryId: park.heldFor },
      {},
      undefined,
    );
    if (one.sent.kind === 'refused' && one.sent.reason === 'ownedElsewhere')
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
    tx,
    { runId: child, outcome: ends },
    Effect.succeed({ rows: delivered }),
  );
});

/**
 * The tail's triggers, each in `scope`: a result parked for a parent this
 * process holds is delivered; a delivered result a child this process runs
 * was holding clears its waiting park. The tail goes on past a failure, so
 * one is told to the person here, once: the parent's next resume delivers
 * the result again (`deliverHeld`).
 */
export const onHeldResult = Effect.fn('onHeldResult')(function* (
  event: SessionEvent,
  scope: Scope.Scope,
): Effect.fn.Return<unknown, never, SessionServices> {
  const target = aggregateTarget(event.aggregateId);
  if (target.kind !== 'run') return;
  const view = yield* SessionViewAccess;
  const log = yield* SessionLog;
  const record = recordOf(event);
  const sent = record.followUps[0];
  let work: Effect.Effect<void, Error, SessionServices> | undefined;
  if (sent?.content.from.kind === 'run') {
    const child = sent.content.from.runId;
    if (view.run(child)?.substate === RUN_SUBSTATE.RESULT_WAITING)
      work = clearHeld(log, child, sent.followUpId);
  } else if (record.heldParks[0]?.park.heldFor !== undefined) {
    const parent = view.run(target.id)?.parentId;
    if (parent != null)
      work = Effect.gen(function* () {
        if (yield* log.owns(parent)) yield* deliverHeld(parent);
      });
  }
  if (work === undefined) return;
  const interactions = yield* Interactions;
  yield* work.pipe(
    Effect.catch((error) =>
      presentRunFailure(
        interactions,
        error,
        "A subagent's result could not be delivered: ",
      ),
    ),
    Effect.forkIn(scope),
  );
});

/** A child this process runs, whose held result `followUpId` was just
 *  delivered, parks plainly again: the card stops reading it as waiting. */
const clearHeld = (
  log: SessionLog['Service'],
  child: RunId,
  followUpId: string,
): Effect.Effect<void, Error> =>
  log.transact((tx) =>
    Effect.gen(function* () {
      if (!(yield* log.owns(child))) return;
      const park = (yield* heldParks(log, child)).at(-1)?.park;
      if (park === undefined || park.heldFor !== followUpId) return;
      yield* tx.append([
        {
          type: 'child.park',
          aggregateId: park.aggregateId,
          phase: 'parked',
        },
      ]);
    }),
  );

/** The envelope a child's kind delivers its failure in. */
const TAG_OF = {
  process: DELIVERY_TAG.backgroundError,
  script: DELIVERY_TAG.scriptError,
  agent: DELIVERY_TAG.subagentError,
} as const;

/**
 * Tell `parent`, once per child, that `child`'s work was interrupted and its
 * outcome is unknown (`why`: what refused its resume; `finished`, it cannot
 * continue by its kind). A child not ended ends failed with the notice as
 * its last turn's result (its own report alone with no parent), under its
 * own claim for that end alone; one that ended (a clean close stopped a
 * task) only sends it.
 */
const reportInterrupted = Effect.fn('reportInterrupted')(function* (
  parent: RunId | null,
  child: RunView,
  facts: RunRows,
  why: string,
) {
  const noun =
    child.identity.kind === 'process' ? 'command' : child.identity.kind;
  const message = formatDelivery({
    tag: TAG_OF[child.identity.kind],
    runId: child.id,
    attributes:
      child.command === null ? [] : [{ name: 'command', value: child.command }],
    message: `The process running this ${noun} stopped before it finished${why === 'finished' ? '' : `, and it could not be resumed (${why})`}, so its outcome is unknown. Check what it changed before running it again.`,
  });
  const item = {
    text: message,
    from: { kind: 'run', runId: child.id } as const,
    deliveryId: `${child.id}:interrupted`,
  };
  if (facts.end !== null) {
    if (parent !== null) yield* sendToParent(item, parent, {}, undefined);
    return;
  }
  const result = childTurnResult({
    runId: child.id,
    // The turn the cut left open; none if it came before the turn began.
    turn: facts.childTurn.active ?? { key: child.id, index: 1 },
    message,
    resultMeta: undefined,
    consumed: [],
    deliveryId: item.deliveryId,
    to: parent,
    end: 'failed',
  });
  yield* Effect.scoped(
    finalizeRun({
      runId: child.id,
      outcome: RUN_OUTCOME.FAILED,
      ownerless: true,
      lastTurn: () => Effect.succeed(turnResultPart(result, undefined)),
    }),
  );
});

/** A turn accepted and never settled, or none begun: work the cut left
 *  open, as opposed to a child resting after it delivered its last turn. */
const cutShort = ({ childTurn }: RunRows): boolean =>
  childTurn.active !== null || childTurn.lastCompleted === null;

/**
 * The one closer of what a dead process or a clean close left of `run`: a
 * child of `parent` as it resumes, or a process run a detach left with no
 * parent as a session opens (`sweepLeftoverRuns`). One cut short whose
 * process is gone, or that a clean close stopped (its `run.end` reason
 * `shutdown`), is resumed under its own id when its rows can continue,
 * so its result reaches its parent as it would have; one that cannot
 * continue (a background command, a task that ended, a resume refused once
 * it decides) is reported ({@link reportInterrupted}). Left alone: a run
 * live here, one an open call owns (the call reattaches it), one a live
 * process holds, one resting after its last turn, and one that ended on its
 * own or under a user's stop.
 */
export const closeLeftoverRun = Effect.fn('closeLeftoverRun')(function* (
  parent: RunId | null,
  run: RunView,
) {
  if ((yield* Runs).get(run.id) !== undefined) return;
  const facts = yield* (yield* SessionLog).facts(run.id);
  if (facts === null || !cutShort(facts)) return;
  if (facts.end !== null && facts.end.reason !== 'shutdown') return;
  if ((yield* owningCall(run.id)) !== null) return;
  const report = (why: string) => reportInterrupted(parent, run, facts, why);
  const rejection = yield* runRejection(run.id);
  if (rejection?.kind === 'ownedElsewhere') return;
  if (rejection !== null) return yield* report(rejection.kind);
  const attempt = yield* openResume(run.id, {}, true);
  if (attempt === undefined) return;
  // A resume refused once it decides is reported; one blocked on a missing
  // agent or plugin is the catalog follower's to retry, and one that failed
  // is left for the next resume, said once.
  const told = (what: string) => (error: unknown) =>
    warn(undefined, `Child run ${run.id} ${what}`, { parent, error });
  yield* Effect.forkScoped(
    Effect.matchEffect(attempt.answer, {
      onSuccess: (answer) =>
        'failed' in answer && answer.failed.kind !== 'blocked'
          ? report(answer.failed.kind)
          : Effect.void,
      onFailure: told('was not resumed'),
    }).pipe(Effect.catch(told('was not reported interrupted'))),
  );
});

/** {@link closeLeftoverRun} of `runId`'s children, as `runId` resumes. */
export const closeLeftoverChildren = Effect.fn('closeLeftoverChildren')(
  function* (runId: RunId) {
    // The listing with this run's activation folded: a child is admitted
    // under a run the view reads as running, not as stopped.
    yield* (yield* SessionLog).settled;
    const { runs } = yield* (yield* SessionViewAccess).read([]);
    for (const child of runs.values())
      if (child.parentId === runId) yield* closeLeftoverRun(runId, child);
  },
);
