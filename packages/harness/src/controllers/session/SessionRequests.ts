/**
 * Handle a surface's request once, with an `Outcome` or request error.
 * Check sequence rows and ownership first; `submitFollowUp` checks messages.
 */
import { Context, Effect, FileSystem, Path } from 'effect';
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

import { submitFollowUp, wakeIfOwed } from '@agent/followUp/ToolUseFollowUp';
import { Inbox } from '@agent/followUp/Inbox';
import {
  narrows,
  decideUnderGrant,
  setPolicy,
  writeRejection,
} from '@agent/runtime/runApprovalQueue';
import { forkRun } from '@agent/runtime/forkRun';
import { attachedMedia } from '@agent/runtime/run/mediaInput';
import { decideRequest } from '@agent/runtime/requests';
import { RunRegistry } from '@agent/runtime/runRegistry';
import type { SessionRequestsShape } from '@agent/runtime/SessionHandle';
import { sessionServices } from '@agent/runtime/ToolServices';
import { GlobalValues } from '@platform/processRuntime';
import { SessionRoots } from '@platform/rootedFs';
import {
  answerMismatch,
  blocksCaller,
  readToolEditContent,
  type RunAction,
  type RunId,
  runNoun,
} from '@shared/schemas';
import type { AggregateState, Database } from '@shared/session/database';
import {
  Rejected,
  Unavailable,
  type Outcome,
  type RequestError,
  type RuntimeCommand,
} from '@shared/session/runtimeRequest';
import type { SessionEventsShape } from '@shared/session/sessionEvents';
import { SessionLog, type SessionViewAccess } from '@shared/session/runHistory';
import { runActionRefusal } from '@shared/session/runActions';
import { descriptionRow } from '@shared/session/runFacts';
import { HostSkillSources, skillActivationText } from '@skills/runtimeSkills';
import { factRows } from '@tools/plugins';
import { ToolRegistry, type ToolTable } from '@tools/toolTable';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  deleteAcceptedRun,
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
/** What rendering a message's activated skills takes of `services`: the
 *  skill sources the process discovers. */
const skillReadOf = Context.pick(FileSystem.FileSystem, HostSkillSources);

/** The log's existence read, and removal through the session's publisher. */
type SessionRequestLog = Pick<
  Context.Service.Shape<typeof Database>,
  'aggregateState'
> &
  Pick<SessionEventsShape, 'removeRun'>;

/** What the session layer builds a session's requests over. */
interface SessionRequestsInit {
  /** The root's log: acceptance reads and removal. */
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

/** Refuse a gated request the run's `actions` no longer hold, read from
 *  the log as of the call (the current view trails it, and a window fed by
 *  the log can ask before the view has applied a row); a run the log does
 *  not hold is left to `accept`. */
const requireRunAction = (
  deps: SessionRequestsInit,
  req: RuntimeCommand,
): Effect.Effect<void, RequestError> => {
  let action = GATED_ACTIONS[req.kind];
  if (req.kind === 'policy.set' && narrows(req.change)) action = undefined;
  if (req.kind === 'request.decide' && req.grant != null) action = 'grant';
  if (action === undefined) return Effect.void;
  const gated = action;
  const runId = req.kind === 'policy.set' ? req.change.runId : req.runId;
  return Effect.flatMap(deps.view.read([runId]), (view) => {
    const run = view.runs.get(runId);
    return run === undefined || run.actions.includes(gated)
      ? Effect.void
      : Effect.fail(new Rejected({ reason: runActionRefusal(run, gated) }));
  });
};

/** The run's stored aggregate state; `undefined` while it has no rows. */
const storedState = (
  deps: SessionRequestsInit,
  runId: RunId,
): Effect.Effect<AggregateState | undefined> =>
  deps.log.aggregateState([runId]).pipe(
    Effect.orDie,
    Effect.map((rows) => rows[0]),
  );

const noLongerOpen = (deps: SessionRequestsInit, runId: RunId) =>
  new Unavailable({
    runId,
    reason: `The ${runNoun(deps.view.run(runId))} is no longer open.`,
  });

/** Accept on current sequence rows: the run exists and is open. */
const accept = (
  deps: SessionRequestsInit,
  req: RuntimeCommand,
): Effect.Effect<AggregateState, RequestError> => {
  const runId = req.kind === 'policy.set' ? req.change.runId : req.runId;
  return Effect.flatMap(
    storedState(deps, runId),
    (state): Effect.Effect<AggregateState, RequestError> =>
      !state || state.closed
        ? Effect.fail(noLongerOpen(deps, runId))
        : Effect.succeed(state),
  );
};

/** The user's title: the run's `run.description` row. */
const rename = (
  deps: SessionRequestsInit,
  req: Extract<RuntimeCommand, { kind: 'run.rename' }>,
): Effect.Effect<Outcome, RequestError> =>
  deps.sessionLog
    .transact([descriptionRow(req.runId, req.title, 'user')])
    .pipe(
      Effect.mapError(
        writeRejection(req.runId, 'The title could not be saved'),
      ),
      Effect.as(done),
    );

/**
 * The pending request `requestId` of run `runId`, read from the log. Not the
 * current view: a window fed by the service's log can list a request the
 * moment it is committed, before the service's view has applied it, and
 * preview or decide it at once.
 */
const pendingOf = (
  deps: SessionRequestsInit,
  runId: RunId,
  requestId: string,
) =>
  Effect.map(deps.view.read([runId]), (view) =>
    view.requests.find(
      (row) => row.runId === runId && row.requestId === requestId,
    ),
  );

const decideSurfaceRequest = (
  deps: SessionRequestsInit,
  req: Extract<RuntimeCommand, { kind: 'request.decide' }>,
  heldHere: boolean,
): Effect.Effect<Outcome, RequestError, GlobalValues | SessionServices> => {
  const answer = Effect.fn('answer')(function* <R>(
    write: Effect.Effect<boolean, RequestError, R>,
  ) {
    const pending = yield* pendingOf(deps, req.runId, req.requestId);
    if (pending === undefined) return yield* notPending(req.runId);
    // A request that blocks its caller is answered by the fiber waiting on it,
    // and that fiber died with the owner this decision takes over from:
    // recording a decision would clear the panel without doing what it says.
    // Resuming the run cancels this request; the call asks again and is
    // answered then.
    if (!heldHere && blocksCaller(pending.payload)) {
      return yield* new Unavailable({
        runId: req.runId,
        reason: `The ${runNoun(deps.view.run(req.runId))} that asked is no longer running: resume it to answer this request.`,
      });
    }
    const { payload } = pending;
    if (payload.kind !== 'plugin') {
      if (!(yield* write)) return yield* notPending(req.runId);
      return done;
    }
    // A plugin's request: the plugin's record outside the session's store
    // first (`Plugin.decision`, idempotent), then one checked transaction
    // holding the decision, the facts the plugin states, checked in the
    // job, and the input it sends a run, accepted in the job. None of them
    // lands without the decision, and a request decided meanwhile commits
    // none of them. The run is woken for that input once it committed.
    const plugin =
      deps.plugins.entries.get(payload.plugin) ??
      (yield* new Unavailable({
        runId: req.runId,
        reason: `Plugin "${payload.plugin}" is unavailable: restore it to answer this request.`,
      }));
    const recorded =
      plugin.decision === undefined
        ? { facts: [] }
        : yield* Effect.orDie(
            plugin.decision.record({ payload, decision: req.decision }),
          );
    const { followUp } = recorded;
    const inbox = yield* Inbox;
    const log = deps.sessionLog;
    const beside = Effect.gen(function* () {
      const facts = yield* factRows(recorded.facts, req.runId, plugin, log);
      if (followUp === undefined) return facts;
      const accepted = yield* inbox.acceptance(
        followUp.runId,
        followUp.item,
        {},
      );
      if (accepted.sent.kind === 'refused')
        yield* Effect.logWarning(
          `Run ${followUp.runId} refused what plugin "${payload.plugin}" sent it with the answer to request ${req.requestId}: its input is closed.`,
        );
      return [...facts, ...accepted.rows];
    }).pipe(Effect.scoped);
    const landed = yield* decideRequest(
      req.runId,
      req.requestId,
      req.decision,
      beside,
    ).pipe(
      Effect.provideService(SessionLog, log),
      Effect.mapError(
        writeRejection(req.runId, 'The decision could not be recorded'),
      ),
    );
    if (!landed) return yield* notPending(req.runId);
    if (followUp !== undefined) yield* wakeIfOwed(followUp.runId);
    return done;
  });
  // An answer the request does not take is refused before its grant.
  return Effect.flatMap(
    pendingOf(deps, req.runId, req.requestId),
    (pending) => {
      const reason =
        pending && answerMismatch(pending, req.decision, req.grant);
      if (reason) return Effect.fail(new Rejected({ reason }));
      return decideUnderGrant(req, answer);
    },
  );
};

/** Queued on the run's input by its live loop's controls, answered once the
 *  input holds it. */
const viaControls = Effect.fn('SessionRequests.viaControls')(function* (
  deps: SessionRequestsInit,
  req: Extract<RuntimeCommand, { kind: `run.${'compact' | 'model'}` }>,
  runs: RunRegistry['Service'],
): Effect.fn.Return<Outcome, RequestError, Inbox> {
  const { runId } = req;
  const unavailable = (reason: string) => new Unavailable({ runId, reason });
  const controls = runs.get(runId)?.controls;
  if (controls === undefined)
    return yield* unavailable(
      req.kind === 'run.compact'
        ? `This ${runNoun(deps.view.run(runId))} has no conversation to compact.`
        : `Resume the ${runNoun(deps.view.run(runId))} to switch its model.`,
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
  deps: SessionRequestsInit,
  req: Exclude<RuntimeCommand, { kind: 'run.stop' | `followUp.${string}` }>,
  accepted: AggregateState,
  heldHere: boolean,
  runs: RunRegistry['Service'],
): Effect.Effect<Outcome, RequestError, RequestServices | SessionServices> => {
  switch (req.kind) {
    case 'run.delete':
      return deleteAcceptedRun(deps, req.runId, accepted, runs);
    case 'run.compact':
    case 'run.model':
      return viaControls(deps, req, runs);
    case 'run.rename':
      return rename(deps, req);
    case 'run.files':
      return runFiles(runs, req);
    case 'run.fork':
      return forkRun({ id: req.runId, uid: accepted.uid }, req.at ?? null).pipe(
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

/** The session's requests: the handler that accepts on the log's sequence
 *  table, and a run's questions to a person. One value per session. */
export function sessionRequests(
  deps: SessionRequestsInit,
): SessionRequestsShape {
  const request = Effect.fn('SessionRequests.request')(function* (
    req: RuntimeCommand,
  ) {
    // A message skips `accept`: `submitFollowUp` refuses on the run's rows
    // and keeps its run's sends in order, its media read included.
    if (req.kind === 'followUp.send') {
      const roots = yield* SessionRoots;
      const skills = req.skills ?? [];
      // The skills the user activated lead the text the run reads, read with
      // the media in the run's send lane; the transcript shows what was
      // typed.
      const skillText =
        skills.length === 0
          ? Effect.succeed({})
          : skillActivationText(roots, skills, req.text).pipe(
              Effect.provideContext(skillReadOf(deps.services)),
              Effect.catchTag('StateReadFailed', (error) =>
                Effect.fail(
                  new Unavailable({
                    runId: req.runId,
                    reason: `The activated skills could not be read: ${error.message}`,
                  }),
                ),
              ),
              Effect.map((text) => ({
                text,
                displayText: req.displayText ?? req.text,
              })),
            );
      const prepare = Effect.all([
        Effect.provideContext(
          attachedMedia(req.media ?? [], roots),
          mediaReadOf(deps.services),
        ),
        skillText,
      ]).pipe(Effect.map(([media, text]) => ({ ...media, ...text })));
      const result = yield* submitFollowUp(
        req.runId,
        {
          text: req.text,
          ...(req.displayText == null ? {} : { displayText: req.displayText }),
          from: { kind: 'user' },
        },
        {
          hold: req.holdUntil,
          prepare,
          apiKeys: req.apiKeys,
          ...(skills.length > 0 && { skills }),
        },
      ).pipe(
        // The refusals a send states: its own, and a skill read that failed.
        Effect.catchIf(
          (e): e is Error =>
            !(e instanceof Rejected) && !(e instanceof Unavailable),
          Effect.die,
        ),
      );
      if (result.status === 'failed')
        return yield* new Unavailable({
          runId: req.runId,
          reason: result.message,
        });
      return { kind: 'followUp' as const, ...result };
    }
    const runs = yield* RunRegistry;
    if (req.kind === 'run.stop') {
      // Refused for a closed run no fiber here drives. An id with no rows
      // yet is a launch its caller minted and has not registered: the
      // registry keeps the stop for its start.
      if (runs.get(req.runId) === undefined) {
        const state = yield* storedState(deps, req.runId);
        if (state?.closed) return yield* noLongerOpen(deps, req.runId);
      }
      return yield* runs.stop(req.runId, req.reason).pipe(
        // An unread setting or a refused row: the run is still in flight.
        Effect.mapError(
          (error): RequestError =>
            new Unavailable({
              runId: req.runId,
              reason: `The ${runNoun(deps.view.run(req.runId))} could not be stopped: ${toErrorMessage(error)}`,
            }),
        ),
        Effect.as(done),
        Effect.uninterruptible,
      );
    }
    yield* requireRunAction(deps, req);
    const accepted = yield* accept(deps, req);
    // A launch here holds the run: a blocked request has a fiber here.
    const heldHere =
      runs.get(req.kind === 'policy.set' ? req.change.runId : req.runId) !==
      undefined;
    return yield* handle(deps, req, accepted, heldHere, runs).pipe(
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
const notPending = (runId: RunId): Unavailable =>
  new Unavailable({ runId, reason: 'No pending request under that id.' });
