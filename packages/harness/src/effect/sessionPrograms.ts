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
 * requests is the host attached to it (`requestAnswerer.ts`). `start` and
 * `resume` hand the run to its registry and give back a view of the
 * activation they opened (`runHandle.ts`).
 */
import { Context, Effect, Schema, SubscriptionRef } from 'effect';

// Each runtime value comes from the module that defines it.
import { AgentCatalog, AgentNotFound } from '@agent/index/agentCatalog';
import { describeFollowUpFailure } from '@agent/followUp/ToolUseFollowUp';
import { resumeRun } from '@agent/runtime/resumeRun';
import type { SessionHandle as RuntimeSessionHandle } from '@agent/runtime/SessionHandle';
import type { ITool } from '@agent/core/tools/ToolTypes';

// The composition root supplies its existing scoped services privately;
// public Session capabilities carry no process implementation types.
import { SessionOwner, type ProcessServices } from '@platform/processRuntime';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  AgentConfigSchema,
  InlinePersonaSchema,
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
import { attachHost } from './requestAnswerer.js';
import { runView } from './runHandle.js';
import { sessionReads } from './sessionReads.js';
import type { Sessions } from './processLayer.js';
import type {
  OpenOptions,
  ResumeInput,
  Run,
  LocalSession,
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
    // The run is named as its persona's schema spells the name.
    const persona =
      typeof agent === 'string'
        ? null
        : yield* Schema.decodeUnknownEffect(InlinePersonaSchema)(agent).pipe(
            Effect.mapError(runFailure),
          );
    return yield* Schema.decodeUnknownEffect(AgentConfigSchema)({
      agent: persona?.name ?? resolved.name,
      agentSource: resolved.source,
      persona,
      instruction: input.instruction,
      ...(input.model ? { model: input.model } : {}),
    }).pipe(Effect.mapError(runFailure));
  });
}

/** Start one run on `session`: a root launch of its runs under the
 *  process's session owner, one cycle long unless it is a window's. */
function start(
  session: RuntimeSessionHandle,
  services: Context.Context<ProcessServices>,
  owner: Context.Service.Shape<typeof SessionOwner>,
  input: StartInput,
): Effect.Effect<Run, LaunchError | RunFailure> {
  return Effect.gen(function* () {
    const config = yield* admitInput(input, session, services);
    const runId = input.runId ?? generateRunId();
    // A supplied id already in the session is refused here; one a launch
    // still opens, its activation refuses (`RunLive`).
    if (
      input.runId !== undefined &&
      (SubscriptionRef.getUnsafe(session.view.ref).runs.has(runId) ||
        session.runs.get(runId) !== undefined)
    )
      return yield* runFailure(
        new Error(`Run ${runId} already exists in this session.`),
      );
    const activation = yield* session.runs
      .launch({
        request: { config, runId },
        options: {
          stopAfterCycle: input.interactive !== true,
          tools: input.tools,
          continues: input.continues,
          preferHelperModel: input.helperModel,
          approveDelegatedWork: input.approval?.delegated,
          approvalPolicy: input.approval?.policy,
        },
      })
      .pipe(
        Effect.provideService(SessionOwner, owner),
        Effect.mapError(runFailure),
      );
    return runView(session, runId, activation);
  });
}

/** What a resume fails with before its run is handed over. */
type ResumeError = ResumeRefused | ToolsRefused | RunFailure;

/**
 * Continue a persisted run of `session` through the one resume path every
 * host takes (`resumeRun`), with the caller's custom tools. A child an open
 * call of its parent owns, as its records say under its claim in its own
 * resume job, is not resumed here: its parent is, whose handle names the
 * child it was asked for. One whose edge is cut resumes itself. A refusal
 * arrives before the run is activated, so it fails this, naming the run
 * refused.
 */
function resume(
  session: RuntimeSessionHandle,
  runId: RunId,
  input: ResumeInput = {},
  redirectedFrom?: RunId,
): Effect.Effect<Run, ResumeError> {
  const { tools, interactive } = input;
  return Effect.gen(function* () {
    yield* admitTools(
      tools ?? [],
      !session.interactions.approvalPromptsUnavailable,
    );
    const resumed = yield* resumeRun(runId, {
      session,
      stopAfterCycle: interactive !== true,
      tools,
    }).pipe(Effect.mapError(runFailure));
    if ('ownedBy' in resumed)
      return yield* resume(
        session,
        resumed.ownedBy,
        input,
        redirectedFrom ?? runId,
      );
    if ('failed' in resumed)
      return yield* new ResumeRefused({
        runId,
        reason: resumed.failed,
        message: describeFollowUpFailure(resumed.failed),
      });
    return runView(session, runId, resumed.activation, redirectedFrom);
  });
}

/** The session as this package works on it: a pure function of the owner's
 *  handle, holding nothing the owner already holds. */
function sessionOf(
  handle: RuntimeSessionHandle,
  services: Context.Context<ProcessServices>,
  owner: Context.Service.Shape<typeof SessionOwner>,
): LocalSession {
  return {
    roots: handle.roots,
    ...sessionReads(handle),
    start: (input) => start(handle, services, owner, input),
    resume: (runId, input) => resume(handle, runId, input),
    request: (request) => handle.requests.request(request),
    attach: (host) => attachHost(handle, host),
  };
}

/** The package's sessions over the process's owner. `services` is the
 *  process's context, which every run's fiber is provided. */
export function makeSessions(
  owner: Context.Service.Shape<typeof SessionOwner>,
  services: Context.Context<ProcessServices>,
): Effect.Effect<Context.Service.Shape<typeof Sessions>> {
  return Effect.sync(() => {
    const sessionFor = (handle: RuntimeSessionHandle): LocalSession =>
      sessionOf(handle, services, owner);
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
              transcriptMode: { kind: 'ephemeral' },
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
