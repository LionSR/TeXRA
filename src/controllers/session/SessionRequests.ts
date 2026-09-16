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
 * rejects is neither: the arms below reach one as an Effect of this same
 * program and die on its untyped failures (`Effect.orDie`), so such a
 * rejection is a handler defect, and `SessionBridge` logs the cause
 * under the request id and answers `Internal`; the sender's latch clears
 * either way. A refusal this handler decides is a `RequestError`; a
 * collaborator breaking is not one to word. In process (the TUI,
 * headless) the Effect's own result is
 * the response; a bridge posts it as the `Response` of 8.4.
 *
 * Built per session by `sessionLayer.ts`'s opener as that session's
 * `Requests`: it acts on exactly the session it was built for, on that
 * session's `Runs`, and on the approval state it carries.
 */
import { Effect, SubscriptionRef, type Context } from 'effect';

import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { RunBusy } from '@agent/runtime/runLanes';
import { Runs } from '@agent/runtime/runRegistry';
import type {
  Requests,
  SessionApprovals,
} from '@agent/runtime/runApprovalQueue';
import { AgentResume, type AgentResumePort } from '@platform/interfaces';
import {
  aggregateId as qualifyAggregateId,
  requestParksItsCaller,
} from '@shared/schemas';
import type { LocalRuntimeState, RunId } from '@shared/schemas';
import { InquiryRecords } from '@shared/session/inquiryRecords';
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
import type { Outcome, RuntimeRequest } from '@shared/session/runtimeRequest';
import { recordInquiryDecision } from '@tools/inquiry/inquiryActions';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';
import { toErrorMessage } from '@utils/errors/errorMessage';

const done: Outcome = Object.freeze({ kind: 'done' } as const);

type SessionRequestLog = Pick<
  Context.Service.Shape<typeof Database>,
  'aggregateState' | 'readAll' | 'removeRun'
>;

/**
 * The session's `Requests`: its approval state and the handler that admits
 * on the log's sequence table. One value per session, so the decision lanes
 * below, like the approval queues beside them, serialize within a session and
 * never across two.
 */
export function sessionRequests(
  session: SessionHandle,
  approvals: SessionApprovals,
  log: SessionRequestLog,
  local: SubscriptionRef.SubscriptionRef<LocalRuntimeState>,
  inquiryRecords: Context.Service.Shape<typeof InquiryRecords>,
  agentResume: AgentResumePort,
): Context.Service.Shape<typeof Requests> {
  /**
   * One in-process serial lane per request id. `decideRequest`'s checked
   * append fences the row across processes, but the row alone: two surfaces
   * of this process deciding one inquiry would both pass the pending check
   * and both reach the thread record before either appended, so the loser's
   * verdict could stand over an answer already recorded and delivered. The
   * lane makes the pending check, the inquiry record and the append one
   * operation per request.
   */
  const decisionLanes = new Map<string, PerKeyLane>();
  const request = Effect.fn('SessionRequests.request')(function* (
    req: RuntimeRequest,
  ) {
    const admitted = yield* admit(log, local, req);
    return yield* handle(
      session,
      approvals,
      decisionLanes,
      req,
      log,
      admitted,
      local,
    ).pipe(
      Effect.provideService(InquiryRecords, inquiryRecords),
      Effect.provideService(Runs, session.runs),
      Effect.provideService(AgentResume, agentResume),
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
    return yield* deleteAdmittedRun(log, runId, admitted, mode).pipe(
      Effect.provideService(Runs, session.runs),
    );
  });
  return { approvals, request, removeRun };
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
 * recorded on the thread and no way to ask again. Two surfaces of this
 * process therefore cannot run this in parallel: the whole decision takes
 * the request's lane ({@link decisionLanes}), so the second reads a request
 * already decided instead of answering its thread behind the first.
 */
function decide(
  session: SessionHandle,
  decisionLanes: Map<string, PerKeyLane>,
  req: Extract<RuntimeRequest, { kind: 'request.decide' }>,
  admitted: AggregateState,
  local: SubscriptionRef.SubscriptionRef<LocalRuntimeState>,
): Effect.Effect<Outcome, RequestError, InquiryRecords | AgentResume> {
  // A run whose owner is gone (proved dead, or a claim already released)
  // takes no append until this process holds its claim: the decision
  // acquires it with the fencing resume uses and gives it back, so a later
  // resume can still take the run.
  const heldHere =
    admitted.ownerId !== null &&
    SubscriptionRef.getUnsafe(local).self.includes(admitted.ownerId);
  const answer = Effect.gen(function* () {
    const pending = SubscriptionRef.getUnsafe(session.view).requests.find(
      (request) =>
        request.runId === req.runId && request.requestId === req.requestId,
    );
    if (pending === undefined) return yield* Effect.fail(settled(req.runId));
    // A request that parks its caller is answered by the fiber waiting on
    // it, and that fiber died with the owner this decision is taking over
    // from: recording a decision would clear the panel without doing what
    // it says. Resuming the run retires those requests
    // (`RunLedger.acquire`) and asks again.
    if (!heldHere && requestParksItsCaller(pending.payload)) {
      return yield* Effect.fail(
        new Unavailable({
          runId: req.runId,
          reason:
            'The run that asked is no longer running: resume it to answer this request.',
        }),
      );
    }
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
          error instanceof DatabaseNotOwner
            ? new NotOwner({ runId: req.runId })
            : new Unavailable({
                runId: req.runId,
                reason: 'The decision could not be recorded.',
              }),
        ),
      );
    if (!recorded) return yield* Effect.fail(settled(req.runId));
    return done;
  });
  return withPerKeyLane(
    decisionLanes,
    `${req.runId}/${req.requestId}`,
  )(
    heldHere
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
        ),
  );
}

/** Delete the admitted lifetime after acquiring its inactive run slot. */
function deleteAdmittedRun(
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
  approvals: SessionApprovals,
  decisionLanes: Map<string, PerKeyLane>,
  req: RuntimeRequest,
  log: SessionRequestLog,
  admitted: AggregateState,
  local: SubscriptionRef.SubscriptionRef<LocalRuntimeState>,
): Effect.Effect<Outcome, RequestError, InquiryRecords | Runs | AgentResume> {
  switch (req.kind) {
    case 'run.stop':
      return Effect.flatMap(Runs, (runs) =>
        runs.stopAgentRun(req.runId, {
          detachActiveChildren: req.detachActiveChildren ?? undefined,
        }),
      ).pipe(
        // The stop fails when the run's terminal row was refused (a live
        // foreign owner, a rolled-back transaction): the run is still in
        // flight, so the requester hears that rather than `done`.
        Effect.mapError(
          (error): RequestError =>
            new Unavailable({
              runId: req.runId,
              reason: `The run could not be stopped: ${toErrorMessage(error)}`,
            }),
        ),
        Effect.as(done),
        Effect.uninterruptible,
      );
    case 'run.delete':
      return deleteAdmittedRun(log, req.runId, admitted, 'single');
    case 'run.compact':
      return Effect.flatMap(Runs, (runs) => {
        const result = runs.requestManualCompaction(req.runId);
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
      return decide(session, decisionLanes, req, admitted, local);
    case 'policy.set':
      return Effect.sync(() => {
        const { change } = req;
        switch (change.bypass) {
          case 'bash':
            approvals.bash.bypass.setBypass(change.runId, change.enabled);
            break;
          case 'toolEdit':
            approvals.toolEdit.bypass.setBypass(change.runId, change.enabled);
            break;
          case 'superYolo':
            approvals.setDelegatedWorkBypasses(change.runId, change.enabled);
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
