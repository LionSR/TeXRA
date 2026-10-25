/**
 * `SessionRequests`: one handler for every request a surface issues to its
 * session's runtime, answered once with an `Outcome` or a request error.
 * Existence is read from the sequence table first: no row is
 * `Unavailable`, a foreign claim without a death
 * proof `NotOwner`, a rejecting collaborator a defect.
 */
import { Effect, SubscriptionRef, type Context } from 'effect';

import {
  describeFollowUpFailure,
  runInbox,
  submitFollowUp,
} from '@agent/followUp/ToolUseFollowUp';
import { detachSubagentsOnStop } from '@agent/runtime/detachSubagentsOnStop';
import { requestAsks } from '@agent/runtime/requestPolicy';
import { narrows, setPolicy } from '@agent/runtime/runApprovalQueue';
import { forkRun, runNoun } from '@agent/runtime/forkRun';
import { registryOf, RunLive, Runs } from '@agent/runtime/runRegistry';
import type {
  SessionHandle,
  SessionRequests,
} from '@agent/runtime/SessionHandle';
import type { GlobalValues } from '@platform/processRuntime';
import {
  qualifyAggregateId,
  requestParksItsCaller,
  type CommitOrdinal,
  type LocalRuntimeState,
  type RunAction,
  type RunId,
} from '@shared/schemas';
import {
  DatabaseClaimRefused,
  type AggregateState,
  claimRejection,
  writeRejection,
  type Database,
  type DeletionMode,
} from '@shared/session/database';
import {
  NotOwner,
  Rejected,
  Unavailable,
  type RequestError,
} from '@shared/session/runtimeRequest';
import type { Outcome, RuntimeRequest } from '@shared/session/runtimeRequest';
import type { SessionEventsShape } from '@shared/session/sessionEvents';
import { runActionRefusal } from '@shared/session/runActions';
import { ownFactRow } from '@tools/plugins';
import type { ToolTable } from '@tools/toolTable';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { runFiles, type RunFilesServices } from './deletionCleanup';

const done: Outcome = Object.freeze({ kind: 'done' } as const);
type RequestServices = GlobalValues | RunFilesServices | Runs;

/** The log's reads, and removal through the session's publisher. */
type SessionRequestLog = Pick<
  Context.Service.Shape<typeof Database>,
  'aggregateState' | 'claimOwner'
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
  readonly services: Context.Context<GlobalValues | RunFilesServices>;
  /** Whether the session's doors are shut (a cancellation writes nothing). */
  readonly closed: () => boolean;
}

/** The run action a request performs, where the run's `actions` gates it. */
const GATED_ACTIONS: Partial<Record<RuntimeRequest['kind'], RunAction>> = {
  'run.delete': 'delete',
  'run.compact': 'compact',
  'run.rename': 'rename',
  'run.files': 'files',
  'policy.set': 'grant',
};

/** One session's requests, as every handler below reads them. */
interface RequestDeps extends SessionRequestsInit {
  /** One in-process lane per request id, making the pending check, the
   *  inquiry record and the append one operation: `decide`'s checked append
   *  fences only the row, so two surfaces here could both record a verdict. */
  readonly decisionLanes: Map<string, PerKeyLane>;
  readonly asks: Pick<SessionRequests, 'ask' | 'decide' | 'decision'>;
}

/** `write` under the run's claim: as is when this process holds the run,
 *  else taken and given back around it (a later resume can still take it). */
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
          .pipe(Effect.mapError(claimRejection(runId)), Effect.andThen(write)),
      );

/** Refuse a gated request the run's `actions` no longer hold; a run not
 *  folded yet, or held elsewhere, is left to `admit` and the claim; a stop
 *  is ungated. */
const requireRunAction = (
  deps: RequestDeps,
  req: RuntimeRequest,
): Effect.Effect<void, RequestError> => {
  let action = GATED_ACTIONS[req.kind];
  if (req.kind === 'policy.set' && narrows(req.change)) action = undefined;
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

/** The user's title: the run's `run.description` row, under its claim. */
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
          writeRejection({
            runId: req.runId,
            reason: 'The title could not be saved.',
          }),
        ),
        Effect.as(done),
      ),
  );

/** The pending request `requestId` of run `runId`, if the view lists it. */
const pendingOf = (deps: RequestDeps, runId: RunId, requestId: string) =>
  SubscriptionRef.getUnsafe(deps.session().view.ref).requests.find(
    (row) => row.runId === runId && row.requestId === requestId,
  );

/**
 * The one way in for a surface's decision (one run model, 3.7): a pending
 * request's `request.decided` row, which the waiting run reads from the
 * tail. {@link decide} re-reads the committed rows in its transaction, so of
 * two surfaces deciding at once one records and the other hears `settled`.
 *
 * The plugin owning the request's kind records its side first (an
 * inquiry's answer, on its cross-project thread), outside the run's
 * transaction, so the whole decision takes the request's lane.
 */
const decideRequest = (
  deps: RequestDeps,
  req: Extract<RuntimeRequest, { kind: 'request.decide' }>,
  heldHere: boolean,
): Effect.Effect<Outcome, RequestError, GlobalValues> => {
  const answer = Effect.gen(function* () {
    const pending = pendingOf(deps, req.runId, req.requestId);
    if (pending === undefined) return yield* Effect.fail(settled(req.runId));
    // A request that parks its caller is answered by the fiber waiting on it,
    // and that fiber died with the owner this decision takes over from:
    // recording a decision would clear the panel without doing what it says.
    // Resuming the run re-enters the call, which asks again and is answered then.
    if (!heldHere && requestParksItsCaller(pending.payload)) {
      return yield* Effect.fail(
        new Unavailable({
          runId: req.runId,
          reason: `The ${runNoun(deps.session(), req.runId)} that asked is no longer running: resume it to answer this request.`,
        }),
      );
    }
    const { log } = deps.session();
    const side = deps.plugins.decisions.get(pending.payload.kind)?.record({
      payload: pending.payload,
      decision: req.decision,
      inbox: (runId) => runInbox(deps.session(), runId),
      commit: (own) => log.transact(own.map((f) => ownFactRow(f, req.runId))),
    });
    if (side) yield* Effect.orDie(side);
    const recorded = yield* deps.asks
      .decide(req.runId, req.requestId, req.decision)
      .pipe(
        Effect.mapError(
          writeRejection({
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

/** Answered by the run's live loop once its resume here settles (none: refused): a /compact or /model sent mid-resume waits until the run rests. */
const viaControls = (
  deps: RequestDeps,
  req: Extract<RuntimeRequest, { kind: `run.${'compact' | 'model'}` }>,
): Effect.Effect<Outcome, RequestError> =>
  Effect.gen(function* () {
    const { runId } = req;
    const unavailable = (reason: string) => new Unavailable({ runId, reason });
    yield* deps.session().followUps.resumeSettled(runId);
    const controls = deps.session().runs.get(runId)?.controls;
    const noun = runNoun(deps.session(), runId);
    if (controls === undefined)
      return yield* unavailable(
        req.kind === 'run.compact'
          ? `This ${noun} has no conversation to compact.`
          : `Resume the ${noun} to switch its model.`,
      );
    const action =
      req.kind === 'run.model'
        ? controls.switchModel(req.model)
        : controls.requestImmediateCompaction();
    return yield* action.pipe(
      Effect.mapError((error) => unavailable(error.message)),
      Effect.as(done),
    );
  });

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
    yield* registryOf(deps.session().runs)
      .withInactiveRunStep(
        runId,
        deps.log.removeRun(aggregateId, mode, admitted.startCommit),
      )
      .pipe(
        Effect.mapError((error): RequestError => {
          if (error instanceof RunLive)
            return new Unavailable({
              runId,
              reason: `Stop the ${runNoun(deps.session(), runId)} before deleting it.`,
            });
          if (error instanceof DatabaseClaimRefused) {
            return error.verdict === 'alive'
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
): Effect.Effect<Outcome, RequestError, RequestServices> => {
  switch (req.kind) {
    case 'run.stop':
      return Effect.gen(function* () {
        const runs = yield* Runs;
        // An explicit child policy wins; an unset one is the session's
        // "Keep subagents running", resolved once for every request's stop.
        const detachActiveChildren =
          req.detachActiveChildren ??
          (yield* detachSubagentsOnStop(deps.session().roots));
        yield* runs.stop(req.runId, {
          detachActiveChildren,
          reason: req.reason,
        }).settlement;
      }).pipe(
        // A setting that would not read, or a refused terminal row (a live
        // foreign owner, a rolled-back transaction): the run is still in
        // flight, so the requester hears that rather than `done`.
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
    case 'run.model':
      return viaControls(deps, req);
    case 'run.rename':
      return rename(deps, req, heldHere);
    case 'run.files':
      return runFiles(deps.session(), req);
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
                  reason: describeFollowUpFailure(result.reason),
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
    case 'request.preview':
      // A request of another run: its staged content is not this caller's.
      return pendingOf(deps, req.runId, req.requestId) === undefined
        ? Effect.succeed({ kind: 'preview', preview: null })
        : Effect.map(
            deps.session().interactions.preview(req.requestId),
            (preview): Outcome => ({ kind: 'preview', preview }),
          );
    case 'policy.set':
      return withRunClaim(
        deps,
        req.change.runId,
        heldHere,
        setPolicy(deps.session(), req.change, heldHere),
      );
  }
};

/** The session's requests: the handler that admits on the log's sequence
 *  table, and a run's questions to a person. One value per session, so the
 *  decision lanes serialize within a session and never across two. */
export function sessionRequests(init: SessionRequestsInit): SessionRequests {
  const deps: RequestDeps = {
    ...init,
    decisionLanes: new Map(),
    asks: requestAsks(init),
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
      Effect.provideContext(deps.services),
      Effect.provideService(Runs, deps.session().runs),
    );
  });

  const removeRun = Effect.fn('SessionRequests.removeRun')(function* (
    runId: RunId,
    mode: DeletionMode,
    expectedStartCommit: CommitOrdinal,
  ) {
    // Listing-driven removal (a history delete, the leftover-shell sweep)
    // acts through the registry's inactive-run step and the claim, which refuse
    // a run anything still holds; `actions` is not consulted, the claim suffices.
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
