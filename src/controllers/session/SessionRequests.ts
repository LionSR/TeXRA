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
 * requests: it acts on exactly the session it was built for, on that
 * session's `Runs`, and on the approval state it carries.
 */
import { Effect, SubscriptionRef, type Context } from 'effect';

import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { detachSubagentsOnStop } from '@agent/runtime/detachSubagentsOnStop';
import { forkRun } from '@agent/runtime/forkRun';
import { RunLive } from '@agent/runtime/runRegistry';
import { Runs } from '@agent/runtime/runRegistry';
import type {
  SessionApprovals,
  SessionRequests,
} from '@agent/runtime/runApprovalQueue';
import {
  aggregateId as qualifyAggregateId,
  requestParksItsCaller,
} from '@shared/schemas';
import type { LocalRuntimeState, RunAction, RunId } from '@shared/schemas';
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
import type { SessionEventsShape } from '@shared/session/sessionEvents';
import { runActionRefusal } from '@shared/session/runActions';
import { recordInquiryDecision } from '@tools/inquiry/inquiryActions';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { setPolicy } from './pendingUnderBypass';

const done: Outcome = Object.freeze({ kind: 'done' } as const);

/** The log's reads, and removal through the session's publisher. */
type SessionRequestLog = Pick<
  Context.Service.Shape<typeof Database>,
  'aggregateState' | 'readAll'
> &
  Pick<SessionEventsShape, 'removeRun'>;

/**
 * The session's requests: its approval state and the handler that admits
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
): SessionRequests {
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
    yield* requireRunAction(session, req);
    const admitted = yield* admit(log, local, req);
    // This process holds the run's claim: a parked request has a fiber here.
    const heldHere =
      admitted.ownerId !== null &&
      SubscriptionRef.getUnsafe(local).self.includes(admitted.ownerId);
    return yield* handle(
      session,
      approvals,
      decisionLanes,
      req,
      log,
      admitted,
      heldHere,
    ).pipe(
      Effect.provideService(InquiryRecords, inquiryRecords),
      Effect.provideService(Runs, session.runs),
    );
  });
  const removeRun = Effect.fn('SessionRequests.removeRun')(function* (
    runId: RunId,
    mode: DeletionMode,
    expectedStartCommit: number,
  ) {
    // Listing-driven removal (`texra history delete`, the leftover-shell
    // sweep) acts through the registry's inactive-run step and the claim,
    // which refuse a run anything still holds; the view's liveness of a
    // spawned run this process registered and never started is not theirs.
    // Deliberately not gated on `actions` either: an explicit delete is how
    // a user clears a run this process cannot read (the UI never offers
    // it), and the claim still protects a run a live process holds.
    const admitted = yield* admit(log, local, { kind: 'run.delete', runId });
    if (admitted.startCommit !== expectedStartCommit) {
      return yield* Effect.fail(
        new Unavailable({
          runId,
          reason: 'The task changed after it was listed.',
        }),
      );
    }
    return yield* deleteAdmittedRun(log, runId, admitted, mode).pipe(
      Effect.provideService(Runs, session.runs),
    );
  });
  return { approvals, request, removeRun };
}

/** The run action a request performs, where the run's `actions` gates it. */
const GATED_ACTIONS: Partial<Record<RuntimeRequest['kind'], RunAction>> = {
  'run.delete': 'delete',
  'run.compact': 'compact',
  'run.rename': 'rename',
  'policy.set': 'grant',
};

/**
 * The user's title, as the run's `run.description` row by the user. A run
 * this process does not hold takes the row under its claim, taken and given
 * back as a decision's is, so a later resume can still take the run.
 */
function rename(
  session: SessionHandle,
  req: Extract<RuntimeRequest, { kind: 'run.rename' }>,
  heldHere: boolean,
): Effect.Effect<Outcome, RequestError> {
  const commit = session
    .commit([
      {
        type: 'run.description',
        aggregateId: qualifyAggregateId('run', req.runId),
        description: req.title,
        by: 'user',
      },
    ])
    .pipe(
      Effect.mapError((error): RequestError =>
        error instanceof DatabaseNotOwner
          ? new NotOwner({ runId: req.runId })
          : new Unavailable({
              runId: req.runId,
              reason: 'The title could not be saved.',
            }),
      ),
      Effect.as(done),
    );
  return withRunClaim(session, req.runId, heldHere, commit);
}

/**
 * `write` under the run's claim: as is when this process holds the run,
 * else taken and given back around it, so a later resume can still take
 * the run.
 */
function withRunClaim<A, R>(
  session: SessionHandle,
  runId: RunId,
  heldHere: boolean,
  write: Effect.Effect<A, RequestError, R>,
): Effect.Effect<A, RequestError, R> {
  if (heldHere) return write;
  return Effect.acquireUseRelease(
    session
      .acquireClaims(qualifyAggregateId('run', runId))
      .pipe(Effect.mapError((): RequestError => new NotOwner({ runId }))),
    () => write,
    (release) => release.pipe(Effect.orDie),
  );
}

/**
 * Refuse a delete, compaction, rename or approval grant the run's current `actions`
 * no longer holds, with its reason: the host rendered it from an earlier
 * view, and the run may have started or ended since. A run the view has not
 * folded yet, and one another process holds, are left to `admit` and the
 * claim (the latter answers `NotOwner`); any other run this process cannot
 * act on is refused here. A stop is not gated: it is always safe to ask,
 * and a run just launched may not have folded live.
 */
function requireRunAction(
  session: Pick<SessionHandle, 'view'>,
  req: RuntimeRequest,
): Effect.Effect<void, RequestError> {
  const action = GATED_ACTIONS[req.kind];
  if (action === undefined) return Effect.void;
  const runId = req.kind === 'policy.set' ? req.change.runId : req.runId;
  const run = SubscriptionRef.getUnsafe(session.view).runs.get(runId);
  // `readOnly` with a foreign owner: a live one (a dead owner's run is not
  // read-only), whose claim answers for the run.
  const heldElsewhere =
    run !== undefined && run.readOnly && run.ownerId !== null && !run.ownedHere;
  return run === undefined || heldElsewhere || run.actions.includes(action)
    ? Effect.void
    : Effect.fail(new Rejected({ reason: runActionRefusal(run, action) }));
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
            reason: 'The task is no longer open.',
          }),
        );
      }
      const liveness = SubscriptionRef.getUnsafe(local);
      // A fork only reads the committed rows of its source, whoever holds it.
      if (
        req.kind !== 'run.delete' &&
        req.kind !== 'run.fork' &&
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
  heldHere: boolean,
): Effect.Effect<Outcome, RequestError, InquiryRecords> {
  // A run whose owner is gone (proved dead, or a claim already released)
  // takes no append until this process holds its claim: the decision
  // acquires it with the fencing resume uses and gives it back, so a later
  // resume can still take the run.
  const answer = Effect.gen(function* () {
    const pending = SubscriptionRef.getUnsafe(session.view).requests.find(
      (request) =>
        request.runId === req.runId && request.requestId === req.requestId,
    );
    if (pending === undefined) return yield* Effect.fail(settled(req.runId));
    // A request that parks its caller is answered by the fiber waiting on
    // it, and that fiber died with the owner this decision is taking over
    // from: recording a decision would clear the panel without doing what
    // it says. Resuming the run re-enters the call, which waits on the
    // same request again, and the answer is taken then.
    if (!heldHere && requestParksItsCaller(pending.payload)) {
      return yield* Effect.fail(
        new Unavailable({
          runId: req.runId,
          reason:
            'The task that asked is no longer running: resume it to answer this request.',
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
  )(withRunClaim(session, req.runId, heldHere, answer));
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
          reason: 'The task has no recorded start.',
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
          reason: 'The task start could not be read.',
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
              reason: 'Stop the task before deleting it.',
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
            reason: 'The task could not be removed from the listing.',
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
  heldHere: boolean,
): Effect.Effect<Outcome, RequestError, InquiryRecords | Runs> {
  switch (req.kind) {
    case 'run.stop':
      return Effect.gen(function* () {
        const runs = yield* Runs;
        // An explicit child policy wins; an unset one is this session's
        // configured "Keep subagents running", resolved here once for every
        // request-borne stop.
        const detachActiveChildren =
          req.detachActiveChildren ??
          (yield* detachSubagentsOnStop(session.roots));
        yield* runs.stop(req.runId, {
          detachActiveChildren,
          reason: req.reason,
        }).settlement;
      }).pipe(
        // The stop fails when the setting could not be read or the run's
        // terminal row was refused (a live foreign owner, a rolled-back
        // transaction): the run is still in flight, so the requester hears
        // that rather than `done`.
        Effect.mapError(
          (error): RequestError =>
            new Unavailable({
              runId: req.runId,
              reason: `The task could not be stopped: ${toErrorMessage(error)}`,
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
                reason: 'This task has no conversation to compact.',
              }),
            );
        }
      });
    case 'run.rename':
      return rename(session, req, heldHere);
    case 'run.fork':
      return forkRun(
        session,
        { id: req.runId, uid: admitted.uid },
        req.at ?? null,
      ).pipe(
        Effect.catchIf(
          (error): error is Error => !(error instanceof Rejected),
          (error) => Effect.die(error),
        ),
        Effect.map((runId): Outcome => ({ kind: 'forked', runId })),
      );
    case 'run.reset':
      return Effect.flatMap(Runs, (runs) => {
        const controls = runs.getHandle(req.runId)?.controls;
        if (controls === undefined)
          return Effect.fail(
            new Unavailable({
              runId: req.runId,
              reason: 'Resume the task to reset it.',
            }),
          );
        return controls.editView(req.handoff ?? null).pipe(
          Effect.mapError(
            (error): RequestError =>
              new Unavailable({ runId: req.runId, reason: error.message }),
          ),
          Effect.as(done),
        );
      });
    case 'followUp.send':
      return submitFollowUp(
        req.runId,
        {
          text: req.text,
          from: { kind: 'user' },
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
      return decide(session, decisionLanes, req, admitted, heldHere);
    case 'policy.set':
      return withRunClaim(
        session,
        req.change.runId,
        heldHere,
        setPolicy(session, approvals, req.change, heldHere),
      );
  }
}
