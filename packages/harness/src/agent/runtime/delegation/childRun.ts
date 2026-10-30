// Third-party imports
import { Effect } from 'effect';

// Local imports
import { TraceEmitter, type StageHandle } from '@agent/trace';
import type { ChildRunPause, ChildRunPort } from '@agent/runtime/childRunLoop';
import {
  parentAdmission,
  type TransactionPart,
} from '@agent/runtime/childTurnResult';
import { formatDelivery } from '@agent/runtime/deliveryEnvelope';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { persistedParentRunId } from '@agent/storage/runRecords';
import {
  qualifyAggregateId,
  RUN_OUTCOME,
  RUN_SUBSTATE,
  ToolError,
} from '@shared/schemas';
import { DELIVERY_TAG } from '@shared/deliveryTags';
import { escapeText } from '@shared/utils/xmlEscape';
import type { RunId } from '@shared/schemas';
import { truncateWithEllipsis } from '@utils/text/stringUtils';
import { generateRunId } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

/**
 * Normalize a child task's raw label to the ≤80-char description
 * `registerRun` writes as the run's one `run.description` row.
 */
export function childRunDescription(raw: string): string {
  return truncateWithEllipsis(raw, 80);
}

/**
 * A child run's trace for a background process child. Every launch site
 * calls this inside `startDetachedChildRunLoop`'s launch guard, which ends
 * a run whose hand-off failed.
 */
export function createChildRun(
  session: SessionHandle,
  runId: RunId,
): ChildRunPort {
  // The run's canonical event publication, from its first event: the trace
  // is built with the session as its sink, and closed with the run.
  return {
    logger: new TraceEmitter((event) => session.log.publish(runId, event)),
  };
}

/**
 * Rest a stopped process child its parent's model can continue, instead of
 * ending it: one transaction commits its last turn's result, the notice as
 * its report, the `child.park` `paused` row with the resume id, and the
 * notice queued for the parent, waking nobody. A child its rows show
 * detached ends cancelled instead (false). A paused child's trace is closed
 * whatever the writes did.
 */
export const pauseChildRun = (
  session: SessionHandle,
  runId: RunId,
  { logger }: ChildRunPort,
  { text: notice, resumeId }: ChildRunPause,
  lastTurn: TransactionPart | undefined,
  stage: Pick<StageHandle, 'end'> | undefined,
): Effect.Effect<boolean, Error> => {
  let paused = true;
  return Effect.gen(function* () {
    const text = formatDelivery({
      tag: DELIVERY_TAG.childPaused,
      runId,
      lines: [escapeText(notice)],
    });
    stage?.end(RUN_OUTCOME.CANCELLED);
    const target = qualifyAggregateId('run', runId);
    // The last turn's result first: the pause notice is the newer report.
    // The notice is read with the parent's next input and offered to nobody:
    // a pause starts no model turn, waiting or busy, and wakes no parent.
    const submitted = yield* session.log.transact((tx) =>
      Effect.gen(function* () {
        const parentRunId = yield* persistedParentRunId(session, runId);
        if (parentRunId === undefined) return undefined;
        const last = yield* lastTurn ??
          Effect.succeed({ rows: [], held: false });
        // A last turn held for a parent open elsewhere already marks the
        // child as waiting: no pause after it (its notice would be refused
        // the same way).
        if (last.held === true) {
          yield* tx.append(last.rows);
          return { parentRunId, sent: { kind: 'duplicate' } };
        }
        // A parent that cannot take the notice refuses it: the pause stands.
        const admitted = yield* parentAdmission(
          session,
          parentRunId,
          { text, from: { kind: 'run', runId } },
          { hold: 'instruction' },
          logger,
        );
        // One append: the pause and its notice commit together.
        yield* tx.append([
          ...last.rows,
          { type: 'run.report', aggregateId: target, report: text },
          {
            type: 'child.park',
            aggregateId: target,
            phase: 'paused',
            resumeId,
          },
          ...admitted.rows,
        ]);
        return { parentRunId, sent: admitted.sent };
      }).pipe(Effect.scoped),
    );
    paused = submitted !== undefined;
    if (submitted === undefined) return false;
    if (submitted.sent.kind === 'refused')
      logger.warn(
        `The pause notice was not queued for parent run ${submitted.parentRunId}; it remains in this run's report.`,
      );
    return true;
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (paused) logger.close();
      }),
    ),
  );
};

/**
 * The run a process child's launch registers: the paused child of `parentRunId`
 * whose pause kept `resumeId`, reactivated rather than left paused beside a
 * new run, else a fresh id. Read from the rows (each run's latest
 * `child.park`, and the view's paused state), not from a live registry, so
 * it holds across a restart.
 */
export const resumedChildRunId = Effect.fn('resumedChildRunId')(function* ({
  session,
  parentRunId,
  resumeId,
}: {
  readonly session: SessionHandle;
  readonly parentRunId: RunId;
  readonly resumeId?: string;
}) {
  if (resumeId === undefined) return generateRunId();
  // Only the paused children of the parent are read, not the session.
  const { runs } = yield* session.view.read([]);
  for (const run of runs.values()) {
    if (run.substate !== RUN_SUBSTATE.PAUSED || run.parentId !== parentRunId)
      continue;
    const park = (yield* session.log
      .facts(run.id)
      .pipe(Effect.mapError((e) => new ToolError(toErrorMessage(e)))))?.park;
    if (park?.resumeId === resumeId) return run.id;
  }
  return generateRunId();
});
