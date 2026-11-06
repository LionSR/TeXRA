/**
 * The ends a run's driver does not write: a failed process-child hand-off,
 * and what a dead process or a clean close left under a run or detached
 * from one (`closeLeftoverRun`).
 */
import { Cause, Effect, Exit } from 'effect';

import { openResume } from '@agent/followUp/ToolUseFollowUp';
import { checkpointRefusal } from '@agent/storage/resumability';
import { finalizeRun } from '@agent/storage/runLifecycle';
import { owningCall } from '@agent/storage/runRecords';
import { classifyAgentError } from '@common/errors/agentErrorClassification';
import { DELIVERY_TAG } from '@shared/deliveryTags';
import { RUN_OUTCOME, type RunId } from '@shared/schemas';
import type { RunRows } from '@shared/session/runRowsShape';
import type { RunView } from '@shared/session/sessionView';
import { SessionViewAccess, SessionLog } from '@shared/session/runHistory';
import { aggregateError } from '@utils/core';
import { ensureError } from '@utils/errors/errorMessage';

import {
  childTurnResult,
  sendToParent,
  turnResultPart,
  warn,
} from './childTurnResult';
import { endVerdict } from './AgentRunLifecycle';
import { formatDelivery } from './deliveryEnvelope';
import { Runs } from './runRegistry';
import type { SessionServices } from './rootLaunch';

/**
 * Hand a registered process child to its loop, which owns its end from
 * there. A hand-off that fails ends the run ownerless (an end the run
 * already wrote stands) as its lifecycle would end it (`endVerdict`), with
 * its classified error, which lets its birth's claim go. The ending's
 * failures join the hand-off's own as one aggregate; an interruption
 * unwinds as itself.
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
              const { outcome, reason, error } = endVerdict(
                Exit.failCause(exit.cause),
                (yield* Runs).stopCause(runId),
              );
              const end = yield* Effect.exit(
                finalizeRun({
                  runId,
                  outcome,
                  reason,
                  ownerless: true,
                  ...(error != null && { error: classifyAgentError(error) }),
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
 * live here, one an open call owns (the call reattaches it), one resting
 * after its last turn, and one that ended on its own or under a user's
 * stop.
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
  const rejection = yield* checkpointRefusal(run.id);
  if (rejection !== null) return yield* report(rejection.kind);
  const attempt = yield* openResume(run.id, {}, true);
  if (attempt === undefined) return;
  // A resume refused once it decides is reported; one blocked on a missing
  // agent or plugin, or one that failed, is left for the next resume, said
  // once.
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
