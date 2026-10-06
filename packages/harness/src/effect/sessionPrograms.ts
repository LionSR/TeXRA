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
  type Scope,
  Semaphore,
  Stream,
} from 'effect';

// Each runtime value comes from the module that defines it: the
// `@agent/runtime` barrel would evaluate runtime files no session here runs.
import { getAgent } from '@agent/index';
import { describeFollowUpFailure } from '@agent/followUp/ToolUseFollowUp';
import { resumeRun } from '@agent/runtime/resumeRun';
import { runAgent as runValidatedAgent } from '@agent/runtime/runAgent';
import type { SessionHandle as RuntimeSessionHandle } from '@agent/runtime/SessionHandle';
import type { SessionOwner } from '@agent/runtime/SessionOwner';
import type { ITool } from '@agent/core/tools/ToolTypes';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';

// The composition root supplies its existing scoped services privately;
// public Session capabilities carry no process implementation types.
import { withLogChannel } from '@logger/effectLog';
import type { ProcessServices } from '@platform/processRuntime';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  InlinePersonaSchema,
  requestParksItsCaller,
  type RunId,
} from '@shared/schemas';
import { attentionOf } from '@shared/session/sessionView';
import { generateRunId } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  AgentNotFound,
  ResumeRefused,
  RunFailure,
  ToolsRefused,
  type LaunchError,
} from './errors.js';
import { handOver } from './runHandle.js';
import type {
  ApprovalHandler,
  OpenOptions,
  Sessions,
  Session,
  Run,
  StartInput,
} from './sessions.js';

const CHANNEL = 'agentPackage';

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

/**
 * Continue a persisted run of `session` through the one resume path every
 * host takes (`resumeRun`), one cycle long as `start`'s are. A run owned by
 * an open call of its parent resumes through that parent. The refusal
 * arrives before the run is admitted, so it fails this rather than the
 * handle.
 */
function resume(
  session: RuntimeSessionHandle,
  services: Context.Context<ProcessServices>,
  runId: RunId,
): Effect.Effect<Run, ResumeRefused | RunFailure> {
  return handOver(session, services, runId, (hooks) =>
    resumeRun(runId, { ...hooks, session, stopAfterCycle: true }).pipe(
      Effect.mapError(runFailure),
      Effect.flatMap((resumed) => {
        if ('failed' in resumed)
          return Effect.fail(
            runFailure(
              new ResumeRefused({
                runId,
                reason: resumed.failed,
                message: describeFollowUpFailure(resumed.failed),
              }),
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
}

/**
 * Answer the runs' requests of `session` with the embedder's `approve`,
 * until the session ends: every request a parked run waits on here (the
 * attention rule every host reads), once, through the session's one
 * `request.decide`. A handler or a decision that fails is logged and its
 * request is offered again on the next view.
 */
function answerRequests(
  session: RuntimeSessionHandle,
  approve: ApprovalHandler,
  ended: Deferred.Deferred<void>,
): Effect.Effect<void> {
  const acted = new Set<string>();
  return session.view.changes.pipe(
    Stream.interruptWhen(Deferred.await(ended)),
    Stream.runForEach((view) =>
      Effect.forEach(
        attentionOf(view).requests.filter(
          (pending) =>
            requestParksItsCaller(pending.payload) &&
            !acted.has(pending.requestId),
        ),
        (pending) => {
          acted.add(pending.requestId);
          return approve(pending).pipe(
            Effect.flatMap((decision) =>
              session.requests.request({
                kind: 'request.decide',
                runId: pending.runId,
                requestId: pending.requestId,
                decision,
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `The approval handler did not answer request ${pending.requestId}; it is offered again on the next view`,
              ).pipe(
                Effect.annotateLogs({ data: cause }),
                withLogChannel(CHANNEL),
                Effect.andThen(
                  Effect.sync(() => acted.delete(pending.requestId)),
                ),
              ),
            ),
            // One handler awaiting its embedder never holds the next.
            Effect.forkChild,
          );
        },
        { discard: true },
      ).pipe(
        // A request gone from the list is decided for good: forget it.
        Effect.andThen(
          Effect.sync(() => {
            const listed = new Set(view.requests.map((r) => r.requestId));
            for (const id of acted) if (!listed.has(id)) acted.delete(id);
          }),
        ),
      ),
    ),
  );
}

/** One reader port per `subscribe`, so no reader disturbs another's set. */
let readerPorts = 0;

/** The session as this package works on it: a pure function of the owner's
 *  handle, holding nothing the owner already holds. */
function sessionOf(
  handle: RuntimeSessionHandle,
  services: Context.Context<ProcessServices>,
): Session {
  return {
    roots: handle.roots,
    start: (input) => start(handle, services, input),
    resume: (runId) => resume(handle, services, runId),
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
    // one that built it, with its own store and its own answerer.
    const opening = yield* Semaphore.make(1);
    const seen = new WeakSet<RuntimeSessionHandle>();
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
        if (!seen.has(handle)) {
          seen.add(handle);
          if (options.approve)
            yield* Effect.forkIn(
              answerRequests(handle, options.approve, ended),
              scope,
            );
        }
        return sessionOf(handle, services);
      }).pipe(opening.withPermit);
    return {
      open,
      close: (roots?: WorkspaceRoots) =>
        owner.close((roots ?? processRoots).storage),
      list: Effect.map(owner.list, (handles) =>
        handles.map((handle) => sessionOf(handle, services)),
      ),
    };
  });
}
