/**
 * The sessions of `@texra-ai/harness` and the runs on them.
 *
 * `Sessions` is a projection of the process's `SessionOwner`: it opens,
 * lists and closes through that one owner, so a root
 * opened here is the same session every host opens (one session per
 * workspace storage root, never a second registry). A {@link Session} is a
 * value, not a tag — there are N of them, one per root — and a pure
 * function of the owner's handle: it stores nothing the owner already
 * holds.
 *
 * What a session is opened with is decided here: its store (memory, or the
 * root's SQLite store that every host keeps). Who answers its runs'
 * requests is the hosts attached to it (`requestAnswerer.ts`). A run's
 * handle is `runHandle.ts`'s; `start` and `resume` differ only in the
 * launch they hand it.
 */
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Schema,
  type Scope,
  SubscriptionRef,
} from 'effect';

// Each runtime value comes from the module that defines it.
import { AgentCatalog, AgentNotFound } from '@agent/index/agentCatalog';
import { describeFollowUpFailure } from '@agent/followUp/ToolUseFollowUp';
import { resumeOwnRun } from '@agent/runtime/resumeRun';
import type { SessionHandle as RuntimeSessionHandle } from '@agent/runtime/SessionHandle';
import type { ITool } from '@agent/core/tools/ToolTypes';

// The composition root supplies its existing scoped services privately;
// public Session capabilities carry no process implementation types.
import { SessionOwner, type ProcessServices } from '@platform/processRuntime';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  AgentConfigSchema,
  InlinePersonaSchema,
  RunIdSchema,
  type RunId,
} from '@shared/schemas';
import { generateRunId } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  ResumeRefused,
  RunFailure,
  ToolsRefused,
  type LaunchError,
} from './errors.js';
import { attachHost, type Approver } from './requestAnswerer.js';
import { handOver } from './runHandle.js';
import { sessionReads } from './sessionReads.js';
import type { Sessions } from './processLayer.js';
import type {
  OpenOptions,
  ResumeInput,
  Run,
  LocalSession,
  Session,
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
          message: `A session no host can answer cannot run approval-requiring tools: ${needApproval.join(', ')}`,
        }),
      )
    : Effect.void;
}

/** The run's configuration, or the refusal that stops it before any model
 *  work: the three the package states. A host's whole configuration is the
 *  config; a named agent is looked up; an inline persona is the agent,
 *  recorded on the config and validated by its schema there. */
function admitInput(
  input: StartInput,
  session: RuntimeSessionHandle,
  services: Context.Context<AgentCatalog>,
): Effect.Effect<typeof AgentConfigSchema.Type, LaunchError | RunFailure> {
  return Effect.gen(function* () {
    const canAsk = !session.interactions.approvalPromptsUnavailable;
    yield* admitTools(input.tools ?? [], canAsk);
    // A host's whole configuration: its launch resolves the agent itself.
    if ('config' in input) return input.config;
    const { agent } = input;
    const resolved =
      typeof agent === 'string'
        ? Context.get(services, AgentCatalog).get(agent)
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
          typeof agent === 'string'
            ? null
            : Schema.decodeUnknownSync(InlinePersonaSchema)(agent);
        return Schema.decodeUnknownSync(AgentConfigSchema)({
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

/** Start one run on `session`: a root launch of its runs under the
 *  process's session owner, one cycle long unless it is a window's. */
function start(
  session: RuntimeSessionHandle,
  services: Context.Context<ProcessServices>,
  owner: Context.Service.Shape<typeof SessionOwner>,
  starting: Set<RunId>,
  input: StartInput,
): Effect.Effect<Run, LaunchError | RunFailure> {
  return Effect.gen(function* () {
    const config = yield* admitInput(input, session, services);
    const runId = input.runId ?? generateRunId();
    // A supplied id is checked and reserved in one step (`starting`, held
    // until the handoff ends, when the run is in the registry): a second
    // start of it is refused, so the id a handoff stops on abandonment is
    // only ever its own launch's.
    if (input.runId !== undefined) {
      const taken =
        starting.has(runId) ||
        SubscriptionRef.getUnsafe(session.view.ref).runs.has(runId) ||
        session.runs.get(runId) !== undefined;
      if (taken)
        return yield* runFailure(
          new Error(`Run ${runId} already exists in this session.`),
        );
      starting.add(runId);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => starting.delete(runId)),
      );
    }
    return yield* handOver(session, services, runId, (hooks) =>
      session.runs
        .launch({
          request: { config, runId },
          options: {
            ...hooks,
            stopAfterCycle: input.interactive !== true,
            // A failure before the run opens is the caller's to present.
            suppressErrorNotification: true,
            tools: input.tools,
            continues: input.continues,
            preferHelperModel: input.helperModel,
            ownApiKeyFallback: input.ownKeyFallback,
            approveDelegatedWork: input.approval?.delegated,
            approvalPolicy: input.approval?.policy,
          },
        })
        .pipe(
          Effect.provideService(SessionOwner, owner),
          Effect.mapError(runFailure),
        ),
    );
  }).pipe(Effect.scoped);
}

/** What a resume fails with before its run is handed over. */
type ResumeError = ResumeRefused | ToolsRefused | RunFailure;

/** The run an open call of `parent` owns resumes with that parent: what
 *  the run's own resume job answers, under its claim. */
class OwnedByParent extends Schema.TaggedError<OwnedByParent>()(
  'OwnedByParent',
  {
    parent: RunIdSchema,
  },
) {}

/**
 * Continue a persisted run of `session` through the one resume path every
 * host takes (`resumeRun`), with the caller's custom tools. A child an open
 * call of its parent owns, as its records say under its claim in its own
 * resume job, is not resumed here: `follow` resumes the parent, whose
 * handle names the child it was asked for. One whose edge is cut resumes
 * itself. A refusal arrives before the run is admitted, so it fails this
 * rather than the handle, naming the run refused.
 */
function resume(
  session: RuntimeSessionHandle,
  services: Context.Context<ProcessServices>,
  runId: RunId,
  { tools, interactive }: ResumeInput,
  follow: (parent: RunId) => Effect.Effect<Run, ResumeError>,
): Effect.Effect<Run, ResumeError> {
  const refused = (reason: ResumeRefused['reason'], message: string) =>
    new ResumeRefused({ runId, reason, message });
  return Effect.gen(function* () {
    yield* admitTools(
      tools ?? [],
      !session.interactions.approvalPromptsUnavailable,
    );
    return yield* handOver(session, services, runId, (hooks) =>
      resumeOwnRun(runId, {
        ...hooks,
        session,
        stopAfterCycle: interactive !== true,
        tools,
      }).pipe(
        Effect.mapError(runFailure),
        Effect.flatMap((resumed) => {
          if ('ownedBy' in resumed)
            return Effect.fail(
              runFailure(new OwnedByParent({ parent: resumed.ownedBy })),
            );
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
      Effect.catch((failure): Effect.Effect<Run, ResumeError> => {
        const { cause } = failure;
        if (cause instanceof OwnedByParent)
          return Effect.map(follow(cause.parent), (run) => ({
            ...run,
            redirectedFrom: runId,
          }));
        return Effect.fail(cause instanceof ResumeRefused ? cause : failure);
      }),
    );
  });
}

/** What the package keeps per session beside the owner's handle: its
 *  attached handlers (newest last) and the supplied run ids starting now. */
interface SessionState {
  readonly approvers: Approver[];
  readonly starting: Set<RunId>;
}

/** The session as this package works on it: a pure function of the owner's
 *  handle, holding nothing the owner already holds. */
function sessionOf(
  handle: RuntimeSessionHandle,
  services: Context.Context<ProcessServices>,
  owner: Context.Service.Shape<typeof SessionOwner>,
  resumeJoined: Session['resume'],
  { approvers, starting }: SessionState,
): LocalSession {
  return {
    roots: handle.roots,
    ...sessionReads(handle),
    start: (input) => start(handle, services, owner, starting, input),
    resume: resumeJoined,
    request: (request) => handle.requests.request(request),
    attach: (host) => attachHost(handle, host, approvers),
  };
}

/** The package's sessions over the process's owner. `services` is the
 *  process's context, which every run's fiber is provided; `scope` is the
 *  layer's, which a joined resume's settlement is forked into. */
export function makeSessions(
  owner: Context.Service.Shape<typeof SessionOwner>,
  services: Context.Context<ProcessServices>,
  scope: Scope.Scope,
): Effect.Effect<Context.Service.Shape<typeof Sessions>> {
  return Effect.sync(() => {
    // The resumes in flight on each session, so a second resume of a run
    // joins the first instead of being refused as live.
    const resuming = new WeakMap<
      RuntimeSessionHandle,
      Map<RunId, Deferred.Deferred<Run, ResumeError>>
    >();
    // Keyed by the run the resume job admits: a child's follows its parent
    // through here, so it joins a resume of that parent already in flight.
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
          return resume(handle, services, runId, input, (parent) =>
            resumeJoined(handle)(parent, input),
          ).pipe(
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
    // Each session's own state beside its handle (`SessionState`).
    const states = new WeakMap<RuntimeSessionHandle, SessionState>();
    const sessionFor = (handle: RuntimeSessionHandle): LocalSession => {
      const state = states.get(handle) ?? {
        approvers: [],
        starting: new Set(),
      };
      states.set(handle, state);
      return sessionOf(handle, services, owner, resumeJoined(handle), state);
    };
    return {
      // An open asking for the other store than the session's is the
      // owner's refusal. Until a host that can prompt attaches, nobody here
      // can answer: the session's policy denies every request its runs
      // raise and offers them no approval-gated tool.
      open: (roots: WorkspaceRoots, { persistent, host }: OpenOptions = {}) =>
        Effect.map(
          owner.open({
            roots,
            ...(host === undefined
              ? { interactions: { approvalPromptsUnavailable: true } }
              : host.interruptedTasks && {
                  interruptedTasks: host.interruptedTasks,
                }),
            ...(!persistent && {
              transcriptMode: {
                kind: 'ephemeral',
                reason: 'npm package consumer',
              },
            }),
          }),
          sessionFor,
        ),
      close: (roots: WorkspaceRoots) => owner.close(roots.storage),
      closeAll: owner.closeAll,
      list: Effect.map(owner.list, (handles) => handles.map(sessionFor)),
    };
  });
}
