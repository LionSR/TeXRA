/**
 * The sessions of `@texra-ai/harness` and the runs on them.
 *
 * `Sessions` is a projection of the process's `SessionOwner`: it opens,
 * lists and closes through that one owner, so a root
 * opened here is the same session every TeXRA host opens (one session per
 * workspace storage root, never a second registry). A {@link Session} is a
 * value, not a tag — there are N of them, one per root — and a pure
 * function of the owner's handle: it stores nothing the owner already
 * holds.
 *
 * What a session is opened with is decided here: its store (memory, or the
 * root's SQLite store that every host keeps), and who answers its runs'
 * requests (nobody, so the session's policy denies them, or the embedder's
 * handler). A run's handle is `runHandle.ts`'s; `start` and `resume` differ
 * only in the launch they hand it. The root entry
 * (`packages/harness/src/index.ts`) re-exports these services as the
 * package's surface.
 */
import {
  type Context,
  Deferred,
  Effect,
  Exit,
  type Scope,
  Semaphore,
} from 'effect';

// Each runtime value comes from the module that defines it: the
// `@agent/runtime` barrel would evaluate runtime files no session here runs.
import { getAgent } from '@agent/index';
import { describeFollowUpFailure } from '@agent/followUp/ToolUseFollowUp';
import { resumeRun } from '@agent/runtime/resumeRun';
import { owningCall } from '@agent/storage/runRecords';
import { runAgent as runValidatedAgent } from '@agent/runtime/runAgent';
import type { SessionHandle as RuntimeSessionHandle } from '@agent/runtime/SessionHandle';
import type { SessionOwner } from '@agent/runtime/SessionOwner';
import type { ITool } from '@agent/core/tools/ToolTypes';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';

// The composition root supplies its existing scoped services privately;
// public Session capabilities carry no process implementation types.
import type { ProcessServices } from '@platform/processRuntime';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { InlinePersonaSchema, type RunId } from '@shared/schemas';
import { generateRunId } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  AgentNotFound,
  ResumeRefused,
  RunFailure,
  SessionOptionsConflict,
  ToolsRefused,
  type LaunchError,
} from './errors.js';
import { answerRequests } from './requestAnswerer.js';
import { handOver } from './runHandle.js';
import type {
  OpenOptions,
  Sessions,
  Session,
  Run,
  StartInput,
} from './sessions.js';

/** A failure of the launch path, as the run's own. */
const runFailure = (cause: unknown): RunFailure =>
  new RunFailure({ cause, message: toErrorMessage(cause) });

/**
 * The refusal the package states from the caller's own input, before
 * anything of the process is touched: on a session nobody answers, a tool
 * that requires approval cannot run whatever the agent turns out to be.
 * {@link admitInput} states it in its own order, before the agent scan.
 */
function admitTools(
  tools: readonly ITool[],
  canAsk: boolean,
): Effect.Effect<void, ToolsRefused> {
  const needApproval = tools
    .filter((tool) => tool.requiresApproval)
    .map((tool) => tool.definition.name);
  return needApproval.length > 0 && !canAsk
    ? Effect.fail(
        new ToolsRefused({
          tools: needApproval,
          message: `A session opened without an approval handler cannot run approval-requiring tools: ${needApproval.join(', ')}`,
        }),
      )
    : Effect.void;
}

/** The run's configuration, or the refusal that stops it before any model
 *  work: the three the package states. A named agent is looked up; an
 *  inline persona is the agent, recorded on the config and validated by its
 *  schema there. */
function admitInput(
  input: StartInput,
  canAsk: boolean,
): Effect.Effect<
  ReturnType<typeof AgentConfigSchema.parse>,
  LaunchError | RunFailure
> {
  return Effect.gen(function* () {
    yield* admitTools(input.tools ?? [], canAsk);
    const { agent } = input;
    const resolved =
      typeof agent === 'string'
        ? getAgent(agent)
        : { name: null, source: 'inline' as const };
    if (!resolved) {
      return yield* new AgentNotFound({
        agent: String(agent),
        message: `Agent "${String(agent)}" was not found in the configured agent directory.`,
      });
    }
    // The schema is the launch's last refusal, and it is a refusal rather
    // than a defect: an instruction this surface will not accept reaches an
    // embedder's `catchTag` in the vocabulary the surface names, as the
    // agent scan's failure above does.
    return yield* Effect.try({
      try: () => {
        // The run is named as its persona's schema spells the name.
        const persona =
          typeof agent === 'string' ? null : InlinePersonaSchema.parse(agent);
        return AgentConfigSchema.parse({
          agent: persona?.name ?? resolved.name,
          agentSource: resolved.source,
          persona,
          instruction: input.instruction,
          ...(input.model ? { model: input.model } : {}),
        });
      },
      catch: runFailure,
    });
  });
}

/** Start one run on `session`: the runtime's `runAgent`, one cycle long. */
function start(
  session: RuntimeSessionHandle,
  services: Context.Context<ProcessServices>,
  input: StartInput,
): Effect.Effect<Run, LaunchError | RunFailure> {
  return Effect.gen(function* () {
    const canAsk = !session.interactions.approvalPromptsUnavailable;
    const config = yield* admitInput(input, canAsk);
    const runId = generateRunId();
    return yield* handOver(session, services, runId, (hooks) =>
      runValidatedAgent(
        { config, runId },
        { ...hooks, session, stopAfterCycle: true, tools: input.tools },
      ).pipe(Effect.mapError(runFailure)),
    );
  });
}

/** What a resume fails with before its run is handed over. */
type ResumeError = ResumeRefused | ToolsRefused | RunFailure;

/**
 * Continue a persisted run of `session` through the one resume path every
 * host takes (`resumeRun`), one cycle long as `start`'s are, with the
 * caller's custom tools. A child an open call of its parent owns is
 * refused: it resumes with that parent, under the parent's handle. A
 * refusal arrives before the run is admitted, so it fails this rather than
 * the handle.
 */
function resume(
  session: RuntimeSessionHandle,
  services: Context.Context<ProcessServices>,
  runId: RunId,
  tools: readonly ITool[] | undefined,
): Effect.Effect<Run, ResumeError> {
  const refused = (
    reason: ResumeRefused['reason'],
    message: string,
  ): ResumeRefused => new ResumeRefused({ runId, reason, message });
  return Effect.gen(function* () {
    yield* admitTools(
      tools ?? [],
      !session.interactions.approvalPromptsUnavailable,
    );
    const owner = yield* owningCall(session, runId).pipe(
      Effect.mapError(runFailure),
    );
    if (owner !== null)
      return yield* refused(
        'not_resumable',
        `Run ${runId} belongs to the open call ${owner.callId} of run ${owner.parentRunId}: resume that run.`,
      );
    return yield* handOver(session, services, runId, (hooks) =>
      resumeRun(runId, { ...hooks, session, stopAfterCycle: true, tools }).pipe(
        Effect.mapError(runFailure),
        Effect.flatMap((resumed) => {
          if ('failed' in resumed)
            return Effect.fail(
              runFailure(
                refused(
                  resumed.failed,
                  describeFollowUpFailure(resumed.failed),
                ),
              ),
            );
          // Only a child its parent no longer owns resumes with no lifetime
          // of its own to report.
          return resumed.completion
            ? resumed.completion.pipe(Effect.mapError(runFailure))
            : Effect.fail(
                runFailure(new Error(`Run ${runId} has no result of its own.`)),
              );
        }),
      ),
    ).pipe(
      Effect.catch((failure) =>
        Effect.fail(
          failure.cause instanceof ResumeRefused ? failure.cause : failure,
        ),
      ),
    );
  });
}

/** One reader port per `subscribe`, so no reader disturbs another's set. */
let readerPorts = 0;

/** The session as this package works on it: a pure function of the owner's
 *  handle, holding nothing the owner already holds. */
function sessionOf(
  handle: RuntimeSessionHandle,
  services: Context.Context<ProcessServices>,
  resumeJoined: Session['resume'],
): Session {
  return {
    roots: handle.roots,
    start: (input) => start(handle, services, input),
    resume: resumeJoined,
    request: (request) => handle.requests.request(request),
    view: { changes: handle.view.changes },
    subscribe: (interests) =>
      Effect.acquireRelease(
        Effect.suspend(() => {
          const port = `sdk/reader/${(readerPorts += 1)}`;
          return Effect.as(handle.view.subscribe(port, interests), port);
        }),
        (port) => handle.view.subscribe(port, []),
      ).pipe(Effect.asVoid),
  };
}

/** The package's sessions over the process's owner. `services` is the
 *  process's context, which every run's fiber is provided; `scope` is the
 *  layer's, which every session's request answerer is forked into. */
export function makeSessions(
  processRoots: WorkspaceRoots,
  owner: Context.Service.Shape<typeof SessionOwner>,
  services: Context.Context<ProcessServices>,
  scope: Scope.Scope,
): Effect.Effect<Context.Service.Shape<typeof Sessions>> {
  return Effect.gen(function* () {
    // Opens are one at a time, so the first open to see a session is the
    // one that built it, with the options it was built with.
    const opening = yield* Semaphore.make(1);
    const built = new WeakMap<RuntimeSessionHandle, OpenOptions>();
    // The resumes in flight on each session, so a second resume of a run
    // joins the first instead of being refused as live.
    const resuming = new WeakMap<
      RuntimeSessionHandle,
      Map<RunId, Deferred.Deferred<Run, ResumeError>>
    >();
    const resumeJoined =
      (handle: RuntimeSessionHandle): Session['resume'] =>
      (runId, input = {}) =>
        Effect.suspend(() => {
          const inFlight =
            resuming.get(handle) ??
            new Map<RunId, Deferred.Deferred<Run, ResumeError>>();
          resuming.set(handle, inFlight);
          const joined = inFlight.get(runId);
          if (joined) return Deferred.await(joined);
          const handOff = Deferred.makeUnsafe<Run, ResumeError>();
          inFlight.set(runId, handOff);
          const forget = Effect.sync(() => {
            inFlight.delete(runId);
          });
          return resume(handle, services, runId, input.tools).pipe(
            Effect.onExit((exit) =>
              Deferred.done(handOff, exit).pipe(
                Effect.andThen(
                  Exit.isSuccess(exit)
                    ? Effect.asVoid(
                        Effect.forkIn(
                          Effect.exit(exit.value.result).pipe(
                            Effect.andThen(forget),
                          ),
                          scope,
                        ),
                      )
                    : forget,
                ),
              ),
            ),
          );
        });
    const sessionFor = (handle: RuntimeSessionHandle): Session =>
      sessionOf(handle, services, resumeJoined(handle));
    const open = (roots?: WorkspaceRoots, options: OpenOptions = {}) =>
      Effect.gen(function* () {
        const ended = yield* Deferred.make<void>();
        const handle = yield* owner.open({
          roots: roots ?? processRoots,
          // With no handler, nothing here can answer an approval prompt:
          // the session's policy denies every request its runs raise and
          // offers them no approval-gated tool.
          interactions: {
            approvalPromptsUnavailable: options.approve === undefined,
            dispose: () => Deferred.doneUnsafe(ended, Effect.void),
          },
          transcriptMode: options.persistent
            ? { kind: 'persistent' }
            : { kind: 'ephemeral', reason: 'npm package consumer' },
        });
        const first = built.get(handle);
        if (first === undefined) {
          built.set(handle, options);
          if (options.approve)
            yield* Effect.forkIn(
              answerRequests(handle, options.approve, ended),
              scope,
            );
        } else if (
          (first.persistent === true) !== (options.persistent === true) ||
          first.approve !== options.approve
        ) {
          return yield* new SessionOptionsConflict({
            storage: handle.roots.storage,
            message: `The session of ${handle.roots.storage} is already open with another store or approval handler; close it before opening it differently.`,
          });
        }
        return sessionFor(handle);
      }).pipe(opening.withPermit);
    return {
      open,
      close: (roots?: WorkspaceRoots) =>
        owner.close((roots ?? processRoots).storage),
      list: Effect.map(owner.list, (handles) => handles.map(sessionFor)),
    };
  });
}
