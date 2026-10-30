import { Effect } from 'effect';
import {
  childTurnResult,
  turnResultPart,
} from '@agent/runtime/childTurnResult';
import { formatDelivery } from '@agent/runtime/deliveryEnvelope';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { finalizeRun } from '@agent/storage/runLifecycle';
import { readChildTurnState } from '@agent/storage/runRecords';
import { withLogChannel } from '@logger/effectLog';
import { DELIVERY_TAG } from '@shared/deliveryTags';
import { RUN_OUTCOME, RUN_SUBSTATE } from '@shared/schemas';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import { claimStanding } from '@shared/session/database';
import type { RunView } from '@shared/session/sessionView';

const CHANNEL = 'LeftoverRunSweep';

/** What a parent reads in place of the result of a shell a restart cut short. */
const INTERRUPTED =
  'A restart interrupted this command before it finished, so its outcome is unknown. Check what it changed before running it again.';

/**
 * End a shell whose process died with an earlier one as a finished shell
 * ends (`finalizeRun`): its last turn's result, saying the command was
 * interrupted, goes to its parent under an id the shell's run id keys, so a
 * later open replays it instead of delivering it twice. A parent that ended
 * or is gone is told nothing. Answers whether the shell may be deleted: not
 * while it holds the result for a parent another process holds, which that
 * process delivers (`deliverHeld`).
 */
const endInterrupted = Effect.fn('endInterrupted')(function* (
  session: SessionHandle,
  { id: runId, parentId, command }: RunView,
) {
  if (parentId === null) return true;
  const parent = yield* session.log.facts(parentId);
  if (parent === null || parent.end !== null) return true;
  // The turn the crash cut short; none if it came before the turn began.
  const { active } = yield* readChildTurnState(session, runId);
  const result = childTurnResult({
    runId,
    turn: active ?? { key: runId, index: 1 },
    // A failed background command's envelope, naming the command it stores.
    message: formatDelivery({
      tag: DELIVERY_TAG.backgroundError,
      runId,
      attributes: [{ name: 'command', value: command }],
      message: INTERRUPTED,
    }),
    resultMeta: undefined,
    consumed: [],
    deliveryId: `${runId}:interrupted`,
    to: parentId,
    end: 'failed',
  });
  // A crash, not a stop: the ownerless end takes the run's claim itself, and
  // records none while the result waits for a parent another process holds.
  const { end } = yield* finalizeRun(session, {
    runId,
    outcome: RUN_OUTCOME.FAILED,
    ownerless: true,
    lastTurn: () => Effect.succeed(turnResultPart(session, result, undefined)),
  });
  return end !== null;
});

/**
 * One shell of the cohort: kept while a live process holds it, else
 * deleted, after telling its parent when a dead process left it running.
 * Liveness is proved here, never read from the view: right after an open
 * the view reads a crashed owner's runs as held until its own proof lands.
 */
const sweepShell = Effect.fn('sweepShell')(function* (
  session: SessionHandle,
  shell: RunView,
) {
  if (!isTerminalOutcomePhase(shell.status)) {
    const claim = yield* session.log.owner(shell.id);
    if (claimStanding(claim).kind !== 'free') return;
    if (!(yield* endInterrupted(session, shell))) return;
  }
  yield* session.requests.removeRun(shell.id, 'automatic', shell.createdAt);
});

/** Remove the nonresumable background-shell cohort captured before session open. */
export const sweepLeftoverRuns = Effect.fn('sweepLeftoverRuns')(function* (
  session: SessionHandle,
  cohort: Iterable<RunView>,
) {
  for (const shell of cohort) {
    // A shell waiting, holding its result for its parent stays until that
    // result is delivered.
    if (
      shell.identity.kind !== 'process' ||
      shell.substate === RUN_SUBSTATE.RESULT_WAITING
    )
      continue;
    yield* sweepShell(session, shell).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          'A background shell was retained because sweeping it failed.',
        ).pipe(
          Effect.annotateLogs({ data: { runId: shell.id, error } }),
          withLogChannel(CHANNEL),
        ),
      ),
    );
  }
});
