/**
 * `SessionRequests`: one handler for every request a surface issues to its
 * session's runtime (PRD one-fold-three-renderers, 7.6 and 8.2). A request
 * is answered exactly once: an `Outcome` the host renders, or one of the
 * request errors. Existence is read from the log's sequence table before
 * any arm runs (contract C2: a run exists iff its sequence row exists
 * and is not closed, minted synchronously by the publish of its `run.start`
 * and ahead of every fold), so a stop issued the moment a launch exposes its
 * run is admitted; a run with no row is `Unavailable`, never a defect
 * (a second surface can act from a view that has not yet folded a
 * `run.removed`). Ownership comes from that same current sequence row:
 * a foreign claim
 * without a death proof is `NotOwner`. Display residency and historical
 * event writers never establish present ownership. A collaborator that
 * rejects is neither: the arms below reach one through `Effect.promise`, so
 * its rejection is a handler defect, and `SessionBridge` logs the cause
 * under the request id and answers `Internal`; the sender's latch clears
 * either way. A refusal this handler decides is a `RequestError`; a
 * collaborator breaking is not one to word. In process (the TUI,
 * headless) the Effect's own result is
 * the response; a bridge posts it as the `Response` of 8.4.
 *
 * Built per `SessionHandle` by `sessionLayer.ts`'s opener: it acts on
 * exactly the session it was built for.
 */
import { Effect, SubscriptionRef, type Context } from 'effect';

import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import type { SessionGraph } from '@agent/runtime/sessionGraph';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { RunBusy } from '@agent/runtime/runLanes';
import { aggregateId as qualifyAggregateId } from '@shared/schemas';
import type { LocalRuntimeState, RunId } from '@shared/schemas';
import { InquiryRecords } from '@shared/session/inquiryRecords';
import {
  DatabaseClaimRefused,
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
import type { Outcome, RuntimeRequest } from '@shared/session/runtimeRequest';
import { recordInquiryDecision } from '@tools/inquiry/inquiryActions';

const done: Outcome = { kind: 'done' };

type SessionRequestLog = Pick<
  Context.Service.Shape<typeof Database>,
  'aggregateState' | 'readAll' | 'removeRun'
>;

/** The session's request handler, admitting on the log's sequence table. */
export function sessionRequests(
  session: SessionHandle,
  log: SessionRequestLog,
  local: SubscriptionRef.SubscriptionRef<LocalRuntimeState>,
  inquiryRecords: Context.Service.Shape<typeof InquiryRecords>,
): SessionGraph['requests'] {
  const request = Effect.fn('SessionRequests.request')(function* (
    req: RuntimeRequest,
  ) {
    const admitted = yield* admit(log, local, req);
    return yield* handle(session, req, log, admitted, local).pipe(
      Effect.provideService(InquiryRecords, inquiryRecords),
    );
  });
  const removeRun = Effect.fn('SessionRequests.removeRun')(function* (
    runId: RunId,
    mode: DeletionMode,
    expectedStartCommit: number,
  ) {
    const admitted = yield* admit(log, local, {
      kind: 'run.delete',
      runId,
    });
    if (admitted.startCommit !== expectedStartCommit) {
      return yield* Effect.fail(
        new Unavailable({
          runId,
          reason: 'The run changed after it was listed.',
        }),
      );
    }
    return yield* deleteAdmittedRun(session, log, runId, admitted, mode);
  });
  return { request, removeRun };
}

/** Admit against current sequence-row existence and claims. A foreign owner
 *  absent from the liveness snapshot is unprovable, so it cannot be admitted.
 *  Deletion uses the database transaction for its explicit single-run exception. */
function admit(
  log: Pick<Context.Service.Shape<typeof Database>, 'aggregateState'>,
  local: SubscriptionRef.SubscriptionRef<LocalRuntimeState>,
  req: RuntimeRequest,
): Effect.Effect<AggregateState, RequestError> {
  // The run a request acts on.
  const runId = req.kind === 'policy.set' ? req.change.runId : req.runId;
  return Effect.flatMap(
    log.aggregateState([qualifyAggregateId('run', runId)]).pipe(
      Effect.orDie,
      Effect.map((rows) => rows[0]),
    ),
    (state): Effect.Effect<AggregateState, RequestError> => {
      if (!state || state.closed) {
        return Effect.fail(
          new Unavailable({
            runId,
            reason: 'The run is no longer open.',
          }),
        );
      }
      const liveness = SubscriptionRef.getUnsafe(local);
      if (
        req.kind !== 'run.delete' &&
        state.ownerId !== null &&
        !liveness.self.includes(state.ownerId) &&
        !liveness.dead.includes(state.ownerId)
      ) {
        return Effect.fail(new NotOwner({ runId }));
      }
      return Effect.succeed(state);
    },
  );
}

/** A decision for a request no longer pending: decided already, or never opened. */
function settled(runId: RunId): Unavailable {
  return new Unavailable({
    runId,
    reason: 'No pending request under that id.',
  });
}

/**
 * The one way in for a decision (one run model, 3.7): the request must be
 * pending (opened, not decided), the decision lands as the run's
 * `request.decided` row, and the waiting run reads it from the tail. The
 * fold routes the arm; `SessionHandle.decideRequest` re-reads the committed
 * rows under the session's publication permit and is the authority, so two
 * surfaces deciding at once record one decision and the loser hears that the
 * request was settled rather than overwriting it.
 *
 * An inquiry's answer is also recorded on its thread and delivered as a
 * follow-up, since an inquiry never parks its run. That record lives in the
 * cross-project inquiry database, so it cannot share the run's transaction;
 * it is written first, because a process that exits in the gap then leaves
 * the request pending and answerable, rather than settled with nothing
 * recorded on the thread and no way to ask again.
 */
function decide(
  session: SessionHandle,
  req: Extract<RuntimeRequest, { kind: 'request.decide' }>,
  admitted: AggregateState,
  local: SubscriptionRef.SubscriptionRef<LocalRuntimeState>,
): Effect.Effect<Outcome, RequestError, InquiryRecords> {
  const answer = Effect.gen(function* () {
    const pending = SubscriptionRef.getUnsafe(session.view).requests.find(
      (request) =>
        request.runId === req.runId && request.requestId === req.requestId,
    );
    if (pending === undefined) return yield* Effect.fail(settled(req.runId));
    if (pending.payload.kind === 'externalInquiry') {
      yield* recordInquiryDecision(
        pending.payload.data,
        req.decision,
        session,
      ).pipe(Effect.orDie);
    }
    const recorded = yield* session
      .decideRequest(req.runId, req.requestId, req.decision)
      .pipe(
        Effect.mapError((error): RequestError =>
          error instanceof DatabaseWriteFailed
            ? new Unavailable({
                runId: req.runId,
                reason: 'The decision could not be recorded.',
              })
            : new NotOwner({ runId: req.runId }),
        ),
      );
    if (!recorded) return yield* Effect.fail(settled(req.runId));
    return done;
  });
  // A run whose owner is gone (proved dead, or a claim already released)
  // takes no append until this process holds its claim: the decision
  // acquires it with the fencing resume uses and gives it back, so a later
  // resume can still take the run.
  const heldHere =
    admitted.ownerId !== null &&
    SubscriptionRef.getUnsafe(local).self.includes(admitted.ownerId);
  return heldHere
    ? answer
    : Effect.acquireUseRelease(
        session
          .acquireClaims(qualifyAggregateId('run', req.runId))
          .pipe(
            Effect.mapError(
              (): RequestError => new NotOwner({ runId: req.runId }),
            ),
          ),
        () => answer,
        (release) => release.pipe(Effect.orDie),
      );
}

/** Delete the admitted lifetime after acquiring its inactive run slot. */
function deleteAdmittedRun(
  session: SessionHandle,
  log: SessionRequestLog,
  runId: RunId,
  admitted: AggregateState,
  mode: DeletionMode,
): Effect.Effect<Outcome, RequestError> {
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
    yield* session.runs
      .withInactiveRunStep(
        runId,
        log.removeRun(aggregateId, mode, start.commit),
      )
      .pipe(
        Effect.mapError((error): RequestError => {
          if (error instanceof RunBusy) return new NotOwner({ runId });
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

function handle(
  session: SessionHandle,
  req: RuntimeRequest,
  log: SessionRequestLog,
  admitted: AggregateState,
  local: SubscriptionRef.SubscriptionRef<LocalRuntimeState>,
): Effect.Effect<Outcome, RequestError, InquiryRecords> {
  switch (req.kind) {
    case 'run.stop':
      return Effect.suspend(() =>
        session.runs.stopAgentRun(req.runId, {
          detachActiveChildren: req.detachActiveChildren ?? undefined,
        }),
      ).pipe(Effect.as(done), Effect.uninterruptible);
    case 'run.delete':
      return deleteAdmittedRun(session, log, req.runId, admitted, 'single');
    case 'run.compact':
      return Effect.suspend((): Effect.Effect<Outcome, RequestError> => {
        const result = session.runs.requestManualCompaction(req.runId);
        switch (result.kind) {
          case 'requested':
            return Effect.succeed(done);
          case 'no_active_tool_use':
            return Effect.fail(
              new Unavailable({
                runId: req.runId,
                reason: 'No active tool-use session found for this run.',
              }),
            );
        }
      });
    case 'followUp.send':
      return submitFollowUp(
        req.runId,
        {
          text: req.text,
          ...(req.displayText == null ? {} : { displayText: req.displayText }),
          ...(req.mediaFiles == null ? {} : { mediaFiles: req.mediaFiles }),
        },
        { session },
      ).pipe(
        Effect.orDie,
        Effect.flatMap((result) =>
          result.status === 'failed'
            ? Effect.fail(
                new Unavailable({
                  runId: req.runId,
                  reason: result.reason,
                }),
              )
            : Effect.succeed<Outcome>({
                kind: 'followUp',
                status: result.status,
                ...(result.status === 'queued' && result.wake === 'failed'
                  ? { wake: 'failed' }
                  : {}),
              }),
        ),
      );
    case 'request.decide':
      return decide(session, req, admitted, local);
    case 'policy.set':
      return Effect.sync(() => {
        const { change } = req;
        switch (change.bypass) {
          case 'bash':
            session.approvals.bash.bypass.setBypass(
              change.runId,
              change.enabled,
            );
            break;
          case 'toolEdit':
            session.approvals.toolEdit.bypass.setBypass(
              change.runId,
              change.enabled,
            );
            break;
          case 'superYolo':
            session.approvals.setDelegatedWorkBypasses(
              change.runId,
              change.enabled,
            );
            break;
        }
        return done;
      });
    case 'workflow.control':
      // A settled call, or an id no live run of this session owns, acted on
      // nothing: the surface hears that, never a `done`.
      return session.workflowControls.control(req.childRunId, req.action)
        ? Effect.succeed(done)
        : Effect.fail(
            new Unavailable({
              runId: req.runId,
              reason: 'No live call under that run id.',
            }),
          );
  }
}
