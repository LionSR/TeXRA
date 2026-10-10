/**
 * `SessionRequests`: one handler for every request a surface issues to its
 * session's runtime (PRD one-fold-three-renderers, 7.6 and 8.2), answered
 * once with an `Outcome` or a request error. Existence is read from the
 * sequence table first (C2), so a stop issued as a launch exposes its run is
 * admitted, and a run with no row is `Unavailable`, never a defect. A foreign claim without a death
 * proof is `NotOwner`. A collaborator that rejects is a handler defect
 * (`Effect.orDie`): `SessionBridge` logs it and answers `Internal`. In
 * process the Effect's result is the response; a bridge posts it (8.4).
 */
import { Effect, SubscriptionRef, type Context } from 'effect';

import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import { detachSubagentsOnStop } from '@agent/runtime/detachSubagentsOnStop';
import { requestAsks } from '@agent/runtime/requestPolicy';
import { setPolicy } from '@agent/runtime/runApprovalQueue';
import { forkRun, runNoun } from '@agent/runtime/forkRun';
import { RunLive, Runs } from '@agent/runtime/runRegistry';
import type {
  SessionHandle,
  SessionRequests,
} from '@agent/runtime/SessionHandle';
import {
  aggregateId as qualifyAggregateId,
  requestParksItsCaller,
  type CommitOrdinal,
  type LocalRuntimeState,
  type RunAction,
  type RunId,
} from '@shared/schemas';
import {
  DatabaseClaimRefused,
  DatabaseWriteFailed,
  GlobalDatabase,
  type AggregateState,
  type Database,
  type DeletionMode,
} from '@shared/session/database';
import {
  NotOwner,
  Rejected,
  Unavailable,
  writeRefused,
  type RequestError,
} from '@shared/session/requestErrors';
import type { Outcome, RuntimeRequest } from '@shared/session/runtimeRequest';
import type { SessionEventsShape } from '@shared/session/sessionEvents';
import { runActionRefusal } from '@shared/session/runActions';
import type { ToolTable } from '@tools/toolTable';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';
import { toErrorMessage } from '@utils/errors/errorMessage';

const done: Outcome = Object.freeze({ kind: 'done' } as const);

/** The log's reads, and removal through the session's publisher. */
type SessionRequestLog = Pick<
  Context.Service.Shape<typeof Database>,
  'aggregateState' | 'claimOwner' | 'readAll'
> &
  Pick<SessionEventsShape, 'removeRun' | 'detach'>;

/** What the session layer builds a session's requests over. */
export interface SessionRequestsInit {
  /** The session these requests act on, resolved when first used. */
  readonly session: () => SessionHandle;
  /** The root's log: admission reads, removal, and the detached door an
   *  interrupted request's cancellation takes. */
  readonly log: SessionRequestLog;
  /** This process's liveness snapshot (`self`, `dead`). */
  readonly local: SubscriptionRef.SubscriptionRef<LocalRuntimeState>;
  readonly plugins: ToolTable;
  readonly globalDatabase: Context.Service.Shape<typeof GlobalDatabase>;
  /** Whether the session's doors are shut: a cancellation then writes
   *  nothing. */
  readonly closed: () => boolean;
}

/** The run action a request performs, where the run's `actions` gates it. */
const GATED_ACTIONS: Partial<Record<RuntimeRequest['kind'], RunAction>> = {
  'run.delete': 'delete',
  'run.compact': 'compact',
  'run.rename': 'rename',
  'policy.set': 'grant',
};

/** One session's requests, as every handler below reads them. */
interface RequestDeps extends SessionRequestsInit {
  /**
   * One in-process serial lane per request id. `decide`'s checked append
   * fences the row across processes, but the row alone: two surfaces of
   * this process deciding one inquiry would both pass the pending check and
   * both reach the thread record before either appended, so the loser's
   * verdict could stand over an answer already recorded and delivered. The
   * lane makes the pending check, the inquiry record and the append one
   * operation per request.
   */
  readonly decisionLanes: Map<string, PerKeyLane>;
  readonly asks: Pick<SessionRequests, 'ask' | 'decide' | 'decision'>;
}

/**
 * `write` under the run's claim: as is when this process holds the run,
 * else taken and given back around it, so a later resume can still take
 * the run.
 */
const withRunClaim = <A, R>(
  deps: RequestDeps,
  runId: RunId,
  heldHere: boolean,
  write: Effect.Effect<A, RequestError, R>,
): Effect.Effect<A, RequestError, R> =>
  heldHere
    ? write
    : Effect.scoped(
        deps
          .session()
          .log.hold(runId)
          .pipe(
            Effect.mapError((): RequestError => new NotOwner({ runId })),
            Effect.andThen(write),
          ),
      );

/**
 * Refuse a delete, compaction, rename or approval grant the run's current
 * `actions` no longer holds, with its reason: the host rendered it from an
 * earlier view, and the run may have started or ended since. A run the
 * view has not folded yet, and one another process holds, are left to
 * `admit` and the claim (the latter answers `NotOwner`). A stop is not
 * gated: it is always safe to ask.
 */
const requireRunAction = (
  deps: RequestDeps,
  req: RuntimeRequest,
): Effect.Effect<void, RequestError> => {
  const action = GATED_ACTIONS[req.kind];
  if (action === undefined) return Effect.void;
  const runId = req.kind === 'policy.set' ? req.change.runId : req.runId;
  const run = deps.session().view.run(runId);
  // `readOnly` with a foreign owner: a live one (a dead owner's run is not
  // read-only), whose claim answers for the run.
  const heldElsewhere =
    run !== undefined && run.readOnly && run.ownerId !== null && !run.ownedHere;
  return run === undefined || heldElsewhere || run.actions.includes(action)
    ? Effect.void
    : Effect.fail(new Rejected({ reason: runActionRefusal(run, action) }));
};

/** Admit on current sequence rows and claims: a foreign owner once proved
 *  dead now, as the snapshot may lag (deletion's exception is its own). */
const admit = (
  deps: RequestDeps,
  req: RuntimeRequest,
): Effect.Effect<AggregateState, RequestError> => {
  const runId = req.kind === 'policy.set' ? req.change.runId : req.runId;
  return Effect.flatMap(
    deps.log.aggregateState([qualifyAggregateId('run', runId)]).pipe(
      Effect.orDie,
      Effect.map((rows) => rows[0]),
    ),
    (state): Effect.Effect<AggregateState, RequestError> => {
      if (!state || state.closed) {
        return Effect.fail(
          new Unavailable({
            runId,
            reason: `The ${runNoun(deps.session(), runId)} is no longer open.`,
          }),
        );
      }
      const liveness = SubscriptionRef.getUnsafe(deps.local);
      // A fork only reads the committed rows of its source, whoever holds it.
      if (
        req.kind !== 'run.delete' &&
        req.kind !== 'run.fork' &&
        state.ownerId !== null &&
        !liveness.self.includes(state.ownerId) &&
        !liveness.dead.includes(state.ownerId)
      ) {
        return Effect.orDie(deps.log.claimOwner(state.aggregateId)).pipe(
          Effect.filterOrFail(
            (claim) => claim.liveness === 'dead',
            () => new NotOwner({ runId }),
          ),
          Effect.as(state),
        );
      }
      return Effect.succeed(state);
    },
  );
};

/**
 * The user's title, as the run's `run.description` row by the user, under
 * the run's claim.
 */
const rename = (
  deps: RequestDeps,
  req: Extract<RuntimeRequest, { kind: 'run.rename' }>,
  heldHere: boolean,
): Effect.Effect<Outcome, RequestError> =>
  withRunClaim(
    deps,
    req.runId,
    heldHere,
    deps
      .session()
      .log.transact([
        {
          type: 'run.description',
          aggregateId: qualifyAggregateId('run', req.runId),
          description: req.title,
          by: 'user',
        },
      ])
      .pipe(
        Effect.mapError(
          writeRefused({
            runId: req.runId,
            reason: 'The title could not be saved.',
          }),
        ),
        Effect.as(done),
      ),
  );

/**
 * The one way in for a surface's decision (one run model, 3.7): the
 * request must be pending, the decision lands as the run's
 * `request.decided` row, and the waiting run reads it from the tail.
 * {@link decide} re-reads the committed rows inside its transaction and is
 * the authority, so two surfaces deciding at once record one decision and
 * the loser hears that the request was settled.
 *
 * The plugin that owns the request's kind records its side first (an
 * inquiry's answer, on its cross-project thread): that record cannot share
 * the run's transaction, and a process that exits in the gap then leaves
 * the request pending and answerable. So the whole decision takes the
 * request's lane.
 */
const decideRequest = (
  deps: RequestDeps,
  req: Extract<RuntimeRequest, { kind: 'request.decide' }>,
  heldHere: boolean,
): Effect.Effect<Outcome, RequestError, GlobalDatabase> => {
  const answer = Effect.gen(function* () {
    const pending = SubscriptionRef.getUnsafe(
      deps.session().view.ref,
    ).requests.find(
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
          reason: `The ${runNoun(deps.session(), req.runId)} that asked is no longer running: resume it to answer this request.`,
        }),
      );
    }
    const hook = deps.plugins.decisions.get(pending.payload.kind);
    if (hook !== undefined)
      yield* hook
        .record({
          payload: pending.payload,
          decision: req.decision,
          session: deps.session(),
        })
        .pipe(Effect.orDie);
    const recorded = yield* deps.asks
      .decide(req.runId, req.requestId, req.decision)
      .pipe(
        Effect.mapError(
          writeRefused({
            runId: req.runId,
            reason: 'The decision could not be recorded.',
          }),
        ),
      );
    if (!recorded) return yield* Effect.fail(settled(req.runId));
    return done;
  });
  return withPerKeyLane(
    deps.decisionLanes,
    `${req.runId}/${req.requestId}`,
  )(withRunClaim(deps, req.runId, heldHere, answer));
};

/** A request the run's live loop answers; refused when none runs here. A
 *  `/compact` is answered once its row commits, never before. */
const viaControls = (
  deps: RequestDeps,
  req: Extract<RuntimeRequest, { kind: 'run.compact' | 'run.reset' }>,
): Effect.Effect<Outcome, RequestError> => {
  const { runId } = req;
  const noun = runNoun(deps.session(), runId);
  const unavailable = (reason: string) => new Unavailable({ runId, reason });
  const controls = deps.session().runs.getHandle(runId)?.controls;
  const missing =
    req.kind === 'run.reset'
      ? `Resume the ${noun} to reset it.`
      : `This ${noun} has no conversation to compact.`;
  if (controls === undefined) return Effect.fail(unavailable(missing));
  return (
    req.kind === 'run.reset'
      ? controls.editView(req.handoff ?? null)
      : controls.requestImmediateCompaction()
  ).pipe(
    Effect.mapError((error) => unavailable(error.message)),
    Effect.as(done),
  );
};

/** Delete the admitted lifetime after acquiring its inactive run slot. */
const deleteAdmittedRun = (
  deps: RequestDeps,
  runId: RunId,
  admitted: AggregateState,
  mode: DeletionMode,
): Effect.Effect<Outcome, RequestError> => {
  const aggregateId = qualifyAggregateId('run', runId);
  return Effect.gen(function* () {
    if (admitted.startCommit === null) {
      return yield* Effect.fail(
        new Unavailable({
          runId,
          reason: `The ${runNoun(deps.session(), runId)} has no recorded start.`,
        }),
      );
    }
    const [start] = yield* deps.log
      .readAll(admitted.startCommit - 1, admitted.startCommit)
      .pipe(Effect.orDie);
    if (start?.type !== 'run.start' || start.aggregateId !== aggregateId) {
      return yield* Effect.fail(
        new Unavailable({
          runId,
          reason: `The ${runNoun(deps.session(), runId)}'s start could not be read.`,
        }),
      );
    }
    yield* deps
      .session()
      .runs.withInactiveRunStep(
        runId,
        deps.log.removeRun(aggregateId, mode, start.commit),
      )
      .pipe(
        Effect.mapError((error): RequestError => {
          if (error instanceof RunLive)
            return new Unavailable({
              runId,
              reason: `Stop the ${runNoun(deps.session(), runId)} before deleting it.`,
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
            reason: `The ${runNoun(deps.session(), runId)} could not be removed from the listing.`,
          });
        }),
      );
    return done;
  });
};

const handle = (
  deps: RequestDeps,
  req: RuntimeRequest,
  admitted: AggregateState,
  heldHere: boolean,
): Effect.Effect<Outcome, RequestError, GlobalDatabase | Runs> => {
  switch (req.kind) {
    case 'run.stop':
      return Effect.gen(function* () {
        const runs = yield* Runs;
        // An explicit child policy wins; an unset one is this session's
        // configured "Keep subagents running", resolved here once for every
        // request-borne stop.
        const detachActiveChildren =
          req.detachActiveChildren ??
          (yield* detachSubagentsOnStop(deps.session().roots));
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
              reason: `The ${runNoun(deps.session(), req.runId)} could not be stopped: ${toErrorMessage(error)}`,
            }),
        ),
        Effect.as(done),
        Effect.uninterruptible,
      );
    case 'run.delete':
      return deleteAdmittedRun(deps, req.runId, admitted, 'single');
    case 'run.compact':
    case 'run.reset':
      return viaControls(deps, req);
    case 'run.rename':
      return rename(deps, req, heldHere);
    case 'run.fork':
      return forkRun(
        deps.session(),
        { id: req.runId, uid: admitted.uid },
        req.at ?? null,
      ).pipe(
        Effect.catchIf(
          (error): error is Error => !(error instanceof Rejected),
          (error) => Effect.die(error),
        ),
        Effect.map((runId): Outcome => ({ kind: 'forked', runId })),
      );
    case 'followUp.send':
      return submitFollowUp(
        req.runId,
        {
          text: req.text,
          from: { kind: 'user' },
          ...(req.displayText == null ? {} : { displayText: req.displayText }),
          ...(req.mediaFiles == null ? {} : { mediaFiles: req.mediaFiles }),
        },
        { session: deps.session() },
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
      return decideRequest(deps, req, heldHere);
    case 'policy.set':
      return withRunClaim(
        deps,
        req.change.runId,
        heldHere,
        setPolicy(deps.session(), req.change, heldHere),
      );
  }
};

/**
 * The session's requests: the handler that admits on the log's sequence
 * table, and a run's questions to a person. One value per session, so the
 * decision lanes serialize within a session and never across two.
 */
export function sessionRequests(init: SessionRequestsInit): SessionRequests {
  const deps: RequestDeps = {
    ...init,
    decisionLanes: new Map(),
    asks: requestAsks({
      session: init.session,
      closed: init.closed,
    }),
  };
  const request = Effect.fn('SessionRequests.request')(function* (
    req: RuntimeRequest,
  ) {
    yield* requireRunAction(deps, req);
    const admitted = yield* admit(deps, req);
    // This process holds the run's claim: a parked request has a fiber here.
    const heldHere =
      admitted.ownerId !== null &&
      SubscriptionRef.getUnsafe(deps.local).self.includes(admitted.ownerId);
    return yield* handle(deps, req, admitted, heldHere).pipe(
      Effect.provideService(GlobalDatabase, deps.globalDatabase),
      Effect.provideService(Runs, deps.session().runs),
    );
  });

  const removeRun = Effect.fn('SessionRequests.removeRun')(function* (
    runId: RunId,
    mode: DeletionMode,
    expectedStartCommit: CommitOrdinal,
  ) {
    // Listing-driven removal (`texra history delete`, the leftover-shell
    // sweep) acts through the registry's inactive-run step and the claim,
    // which refuse a run anything still holds. Deliberately not gated on
    // `actions` either: an explicit delete is how a user clears a run this
    // process cannot read (the UI never offers it), and the claim still
    // protects a run a live process holds.
    const admitted = yield* admit(deps, { kind: 'run.delete', runId });
    if (admitted.startCommit !== expectedStartCommit) {
      return yield* Effect.fail(
        new Unavailable({
          runId,
          reason: `The ${runNoun(deps.session(), runId)} changed after it was listed.`,
        }),
      );
    }
    return yield* deleteAdmittedRun(deps, runId, admitted, mode);
  });

  return { request, removeRun, ...deps.asks };
}

/** A decision for a request no longer pending: decided already, or never opened. */
const settled = (runId: RunId): Unavailable =>
  new Unavailable({ runId, reason: 'No pending request under that id.' });
