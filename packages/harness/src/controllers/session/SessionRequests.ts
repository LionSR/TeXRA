/**
 * Handle a surface's request once, with an `Outcome` or request error.
 * Check sequence rows and ownership first; `submitFollowUp` checks messages.
 */
import { randomUUID } from 'node:crypto';

import { Context, Effect, FileSystem, Path } from 'effect';
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

import {
  describeFollowUpFailure,
  followUpServices,
  runInbox,
  submitFollowUp,
} from '@agent/followUp/ToolUseFollowUp';
import { Inbox } from '@agent/followUp/Inbox';
import { sentFollowUpId, sentReceipt } from '@agent/followUp/followUpMessages';
import {
  narrows,
  decideUnderGrant,
  setPolicy,
  writeRejection,
} from '@agent/runtime/runApprovalQueue';
import { forkRun, runNoun } from '@agent/runtime/forkRun';
import { attachedMedia } from '@agent/runtime/run/mediaInput';
import { registryOf, Runs, type RunRegistry } from '@agent/runtime/runRegistry';
import type { SessionRequestsShape } from '@agent/runtime/SessionHandle';
import { sessionServices } from '@agent/runtime/ToolServices';
import { GlobalValues } from '@platform/processRuntime';
import { SessionRoots } from '@platform/rootedFs';
import {
  answerMismatch,
  qualifyAggregateId,
  blocksCaller,
  readToolEditContent,
  type RunAction,
  type RunId,
} from '@shared/schemas';
import type { AggregateState, Database } from '@shared/session/database';
import {
  Conflict,
  Rejected,
  Unavailable,
  type Outcome,
  type RequestError,
  type RuntimeCommand,
} from '@shared/session/runtimeRequest';
import type { SessionEventsShape } from '@shared/session/sessionEvents';
import type { SessionLog, SessionViewAccess } from '@shared/session/runHistory';
import { runActionRefusal } from '@shared/session/runActions';
import { descriptionRow } from '@shared/session/runFacts';
import { ownFactRow } from '@tools/plugins';
import { ToolRegistry, type ToolTable } from '@tools/toolTable';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  deleteAdmittedRun,
  runFiles,
  type RunFilesServices,
} from './deletionCleanup';

const done: Outcome = Object.freeze({ kind: 'done' } as const);
type RequestServices = GlobalValues | RunFilesServices;
type SessionServices = Effect.Services<typeof sessionServices>;
/** What a handler reads of `services`; never the whole captured context. */
const servicesOf = Context.pick(GlobalValues, FileSystem.FileSystem, Path.Path);
/** What a follow-up's media read takes of `services`. */
const mediaReadOf = Context.pick(FileSystem.FileSystem, ChildProcessSpawner);

/** The log's existence read, and removal through the session's publisher. */
type SessionRequestLog = Pick<
  Context.Service.Shape<typeof Database>,
  'aggregateState'
> &
  Pick<SessionEventsShape, 'removeRun'>;

/** What the session layer builds a session's requests over. */
interface SessionRequestsInit {
  /** The root's log: admission reads and removal. */
  readonly log: SessionRequestLog;
  readonly plugins: ToolTable;
  readonly services: Context.Context<RequestServices | ChildProcessSpawner>;
  readonly sessionLog: SessionLog['Service'];
  readonly view: SessionViewAccess['Service'];
}

/** The run action a request performs, where the run's `actions` gates it. */
const GATED_ACTIONS: Partial<Record<RuntimeCommand['kind'], RunAction>> = {
  'run.delete': 'delete',
  'run.compact': 'compact',
  'run.rename': 'rename',
  'run.files': 'files',
  'policy.set': 'grant',
};

/** One session's requests, as every handler below reads them. */
interface RequestDeps extends SessionRequestsInit {
  /** One in-process lane per request id, making the pending check, the
   *  plugin's record and the append one operation: `decideRequest`'s checked append
   *  fences only the row, so two surfaces here could both record a verdict. */
  readonly decisionLanes: Map<string, PerKeyLane>;
}

/** Refuse a gated request the run's `actions` no longer hold; a run not
 *  folded yet is left to `admit`. */
const requireRunAction = (
  deps: RequestDeps,
  req: RuntimeCommand,
): Effect.Effect<void, RequestError> => {
  let action = GATED_ACTIONS[req.kind];
  if (req.kind === 'policy.set' && narrows(req.change)) action = undefined;
  if (req.kind === 'request.decide' && req.grant != null) action = 'grant';
  if (action === undefined) return Effect.void;
  const runId = req.kind === 'policy.set' ? req.change.runId : req.runId;
  const run = deps.view.run(runId);
  return run === undefined || run.actions.includes(action)
    ? Effect.void
    : Effect.fail(new Rejected({ reason: runActionRefusal(run, action) }));
};

/** Admit on current sequence rows: the run exists and is open. */
const admit = (
  deps: RequestDeps,
  req: RuntimeCommand,
): Effect.Effect<AggregateState, RequestError> => {
  const runId = req.kind === 'policy.set' ? req.change.runId : req.runId;
  return Effect.flatMap(
    deps.log.aggregateState([qualifyAggregateId('run', runId)]).pipe(
      Effect.orDie,
      Effect.map((rows) => rows[0]),
    ),
    (state): Effect.Effect<AggregateState, RequestError> =>
      !state || state.closed
        ? Effect.fail(
            new Unavailable({
              runId,
              reason: `The ${runNoun(deps.view, runId)} is no longer open.`,
            }),
          )
        : Effect.succeed(state),
  );
};

/** The user's title: the run's `run.description` row. */
const rename = (
  deps: RequestDeps,
  req: Extract<RuntimeCommand, { kind: 'run.rename' }>,
): Effect.Effect<Outcome, RequestError> =>
  deps.sessionLog.transact([descriptionRow(req.runId, req.title, 'user')]).pipe(
    Effect.mapError(
      writeRejection({
        runId: req.runId,
        reason: 'The title could not be saved.',
      }),
    ),
    Effect.as(done),
  );

/**
 * The pending request `requestId` of run `runId`, read from the log. Not the
 * current view: a window fed by the service's log can list a request the
 * moment it is committed, before the service's view has applied it, and
 * preview or decide it at once.
 */
const pendingOf = (deps: RequestDeps, runId: RunId, requestId: string) =>
  Effect.map(deps.view.read([runId]), (view) =>
    view.requests.find(
      (row) => row.runId === runId && row.requestId === requestId,
    ),
  );

const decideSurfaceRequest = (
  deps: RequestDeps,
  req: Extract<RuntimeCommand, { kind: 'request.decide' }>,
  heldHere: boolean,
): Effect.Effect<Outcome, RequestError, GlobalValues | SessionServices> => {
  const answer = Effect.fn('answer')(function* <R>(
    write: Effect.Effect<boolean, RequestError, R>,
  ) {
    const pending = yield* pendingOf(deps, req.runId, req.requestId);
    if (pending === undefined) return yield* settled(req.runId);
    // A request that blocks its caller is answered by the fiber waiting on it,
    // and that fiber died with the owner this decision takes over from:
    // recording a decision would clear the panel without doing what it says.
    // Resuming the run re-enters the call, which asks again and is answered then.
    if (!heldHere && blocksCaller(pending.payload)) {
      return yield* new Unavailable({
        runId: req.runId,
        reason: `The ${runNoun(deps.view, req.runId)} that asked is no longer running: resume it to answer this request.`,
      });
    }
    const { payload } = pending;
    const services = yield* followUpServices;
    const side =
      payload.kind === 'plugin'
        ? (
            deps.plugins.entries.get(payload.plugin) ??
            (yield* new Unavailable({
              runId: req.runId,
              reason: `Plugin "${payload.plugin}" is unavailable: restore it to answer this request.`,
            }))
          ).decision?.record({
            payload,
            decision: req.decision,
            inbox: (runId) => runInbox(runId, services),
            commit: (own) =>
              deps.sessionLog.transact(
                own.map((f) => ownFactRow(f, req.runId)),
              ),
          })
        : undefined;
    if (side) yield* Effect.orDie(side);
    if (!(yield* write)) return yield* settled(req.runId);
    return done;
  });
  // An answer the request does not take is refused in the lane, before its grant.
  const decided = Effect.flatMap(
    pendingOf(deps, req.runId, req.requestId),
    (pending) => {
      const reason =
        pending && answerMismatch(pending.payload, req.decision, req.grant);
      if (reason) return Effect.fail(new Rejected({ reason }));
      return decideUnderGrant(req, answer);
    },
  );
  return withPerKeyLane(
    deps.decisionLanes,
    `${req.runId}/${req.requestId}`,
  )(decided);
};

/** Queued on the run's input by its live loop's controls, answered once the
 *  input holds it. */
const viaControls = Effect.fn('SessionRequests.viaControls')(function* (
  deps: RequestDeps,
  req: Extract<RuntimeCommand, { kind: `run.${'compact' | 'model'}` }>,
  runs: RunRegistry,
): Effect.fn.Return<Outcome, RequestError, Inbox> {
  const { runId } = req;
  const unavailable = (reason: string) => new Unavailable({ runId, reason });
  const controls = runs.get(runId)?.controls;
  if (controls === undefined)
    return yield* unavailable(
      req.kind === 'run.compact'
        ? `This ${runNoun(deps.view, runId)} has no conversation to compact.`
        : `Resume the ${runNoun(deps.view, runId)} to switch its model.`,
    );
  const failed = Effect.mapError((error: Error) => unavailable(error.message));
  if (req.kind === 'run.model')
    return yield* controls.switchModel(req.model).pipe(failed, Effect.as(done));
  // A `/compact` queues on the run's input; the live loop answers it.
  const control = { kind: 'compact' } as const;
  const item = { text: '/compact', from: { kind: 'user' }, control } as const;
  const sent = yield* (yield* Inbox).send(runId, item).pipe(failed);
  return sent.kind === 'refused'
    ? yield* unavailable('This conversation takes no more input.')
    : done;
});

const handle = (
  deps: RequestDeps,
  req: Exclude<RuntimeCommand, { kind: 'run.stop' | `followUp.${string}` }>,
  admitted: AggregateState,
  heldHere: boolean,
  runs: RunRegistry,
): Effect.Effect<Outcome, RequestError, RequestServices | SessionServices> => {
  switch (req.kind) {
    case 'run.delete':
      return deleteAdmittedRun(deps, req.runId, admitted, runs);
    case 'run.compact':
    case 'run.model':
      return viaControls(deps, req, runs);
    case 'run.rename':
      return rename(deps, req);
    case 'run.files':
      return runFiles(runs, req);
    case 'run.fork':
      return forkRun({ id: req.runId, uid: admitted.uid }, req.at ?? null).pipe(
        Effect.provideService(ToolRegistry, deps.plugins),
        Effect.catchIf((e): e is Error => !(e instanceof Rejected), Effect.die),
        Effect.map((runId): Outcome => ({ kind: 'forked', runId })),
      );
    case 'request.decide':
      return decideSurfaceRequest(deps, req, heldHere);
    case 'request.preview':
      return Effect.flatMap(
        pendingOf(deps, req.runId, req.requestId),
        (pending): Effect.Effect<Outcome> =>
          pending?.payload.kind === 'toolEdit'
            ? readToolEditContent(
                deps.sessionLog.blobs,
                pending.payload.data.content,
              ).pipe(
                Effect.map(({ originalContent, ...content }) => ({
                  kind: 'preview',
                  preview: {
                    ...content,
                    originalContent: originalContent ?? '',
                  },
                })),
              )
            : Effect.succeed({ kind: 'preview', preview: null }),
      );
    case 'policy.set':
      return setPolicy(req.change, Effect.succeed(done));
  }
};

/** The session's requests: the handler that admits on the log's sequence
 *  table, and a run's questions to a person. One value per session, so the
 *  decision lanes serialize within a session and never across two. */
export function sessionRequests(
  init: SessionRequestsInit,
): SessionRequestsShape {
  const deps: RequestDeps = { ...init, decisionLanes: new Map() };
  const request = Effect.fn('SessionRequests.request')(function* (
    req: RuntimeCommand,
  ) {
    // A message skips `admit`: `submitFollowUp` refuses on the run's rows
    // and keeps its run's sends in order, its media read included; a
    // receipt is read past the run's end too.
    if (req.kind === 'followUp.receipt')
      return {
        kind: 'receipt' as const,
        receipt: yield* sentReceipt(deps.sessionLog, req),
      };
    if (req.kind === 'followUp.send') {
      const attach = Effect.provideContext(
        attachedMedia(req.media ?? [], yield* SessionRoots),
        mediaReadOf(deps.services),
      );
      const id = req.id ?? randomUUID();
      const result = yield* submitFollowUp(
        req.runId,
        {
          text: req.text,
          from: { kind: 'user' },
          ...(req.displayText == null ? {} : { displayText: req.displayText }),
          deliveryId: sentFollowUpId(id),
          ...(req.id != null && { caller: req.id }),
        },
        { hold: req.holdUntil ?? undefined, attach },
      ).pipe(
        Effect.catchIf(
          (e): e is Error => !(e instanceof Rejected || e instanceof Conflict),
          Effect.die,
        ),
      );
      if (result.status === 'failed')
        return yield* new Unavailable({
          runId: req.runId,
          reason: describeFollowUpFailure(result.reason),
        });
      const receipt = yield* sentReceipt(deps.sessionLog, {
        runId: req.runId,
        id,
      });
      return { kind: 'followUp' as const, id, ...result, receipt };
    }
    const runs = registryOf(yield* Runs);
    if (req.kind === 'run.stop') {
      // Admitted on its rows unless a fiber here drives it.
      if (runs.get(req.runId) === undefined) yield* admit(deps, req);
      return yield* runs.stop(req.runId, req.reason).pipe(
        // An unread setting or a refused row: the run is still in flight.
        Effect.mapError(
          (error): RequestError =>
            new Unavailable({
              runId: req.runId,
              reason: `The ${runNoun(deps.view, req.runId)} could not be stopped: ${toErrorMessage(error)}`,
            }),
        ),
        Effect.as(done),
        Effect.uninterruptible,
      );
    }
    yield* requireRunAction(deps, req);
    const admitted = yield* admit(deps, req);
    // A launch here holds the run: a blocked request has a fiber here.
    const heldHere =
      runs.get(req.kind === 'policy.set' ? req.change.runId : req.runId) !==
      undefined;
    return yield* handle(deps, req, admitted, heldHere, runs).pipe(
      Effect.provideContext(
        Context.merge(servicesOf(deps.services), yield* sessionServices),
      ),
    );
  });

  // cast: each case of `handle` answers with its own kind's outcome.
  const perKind = request as SessionRequestsShape['request'];
  return { request: perKind };
}

/** A decision for a request no longer pending: decided already, or never opened. */
const settled = (runId: RunId): Unavailable =>
  new Unavailable({ runId, reason: 'No pending request under that id.' });
