import * as path from 'node:path';

import { Deferred, Effect, Fiber, Layer, Schema } from 'effect';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';
import { withLogChannel } from '@logger/effectLog';
import type { ProcessServices } from '@platform/processRuntime';
import { sessionFsLayer } from '@platform/rootedFs';
import {
  isTaskConfig,
  RunIdSchema,
  type RunId,
  type RequestEnsureProgressViewPayload,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import { RunHistory } from '@shared/session/runHistory';

import { canResume } from '../storage/resumability';
import { persistedParentRunId, withChildSpend } from '../storage/runRecords';
import {
  buildAgentLaunchContext,
  prepareAgentDefinition,
  type PreparedAgentDefinition,
  type AgentLaunchContext,
} from './AgentLaunchContext';
import { runWithLifecycle } from './AgentRunLifecycle';
import {
  generateSessionDescription,
  settleDescriptionOnExit,
} from './sessionDescription';
import { modelInvokerLayer } from './ModelInvoker';
import { agentRunLayer } from './run/AgentRun';
import { runToolUse } from './loop/toolUse';
import { runWithLaunchGuard } from './runLaunchGuard';
import { Runs, type AgentRunServices } from './runRegistry';
import type { RegisterRunOptions } from '../storage/runLifecycle';
import type { ChildRunTurns } from './childRunLoop';
import type { RunEndResult } from './RunEndResult';
import type { SessionHandle } from './SessionHandle';
import type { RunHandle } from './RunHandle';

const CHANNEL = 'executeAgent';

/** A claimed run no longer has the persisted state to resume. */
export class ResumeSessionUnavailableError extends Schema.TaggedError<ResumeSessionUnavailableError>()(
  'ResumeSessionUnavailableError',
  {
    runId: RunIdSchema,
  },
) {
  override get message(): string {
    return 'This session can no longer be resumed. Start a new run instead.';
  }
}

/**
 * The wiring the two entry points genuinely do not share. Everything outside
 * this union is assembled once in {@link launchRun}, so a field added for
 * one entry point cannot go missing on the other.
 */
type LaunchVariant =
  | { readonly kind: 'fresh' }
  | {
      readonly kind: 'resume';
      readonly onIdle?: () => void;
      /** Read on the run's own fiber before its loop starts: a stop asked
       *  before the run was reachable is that fiber's interruption. */
      readonly isCancellationRequested?: () => boolean;
    };

/**
 * The per-run layer both families run under: the run's `AgentRun`, the
 * invoker, the session's run history, and the session's rooted filesystems (built
 * from the roots of the session the run is on, fresh or resumed, so code
 * below the launch takes `WorkspaceFs` / `StorageFs` from context rather than
 * from the fiber's ambient roots). The follow-up lease is not here: a
 * conversation claims its own inside the loop (`claimFollowUps`).
 */
function runLayerFor(
  ctx: AgentLaunchContext,
  shared: SubagentRunOptions,
  onIdle: (() => void) | undefined,
) {
  const runSession = ctx.session;
  return modelInvokerLayer().pipe(
    Layer.provideMerge(
      agentRunLayer(ctx, {
        tools: shared.tools,
        callbacks: {
          onProgress: (update) => {
            // A UI-only signal, suppressed in the transcript fold: the session
            // view updater sets the run's `conversationProgress` from it.
            if (update.kind === 'overview') {
              ctx.logger.emit({
                type: 'conversation.progress',
                progress: { toolCallCount: update.toolCallCount },
              });
            }
            shared.onProgress?.(update);
          },
          ...(onIdle ? { onIdle } : {}),
        },
      }),
    ),
    Layer.provideMerge(Layer.succeed(RunHistory)(runSession.runHistory)),
    Layer.provideMerge(sessionFsLayer(runSession.roots)),
  );
}

/**
 * Run the loop for a single agent run, fresh or resumed.
 *
 * Owns all run wiring: progress counters and model-change side effects, and
 * for a task its children's spend. A failed run
 * arrives as a FAILED result carrying its structured error, so there is
 * nothing to unwrap here. The callers (`executeAgent`,
 * `resumeToolUseFromResumeData`) own lifecycle and stream-status.
 */
function launchRun(
  ctx: AgentLaunchContext,
  handle: RunHandle,
  shared: SubagentRunOptions,
  variant: LaunchVariant,
): Effect.Effect<RunEndResult, Error, AgentRunServices> {
  const task = isTaskConfig(ctx.config);
  /** A task's result, with its children's spend. */
  const withChildrenSpend = (ended: RunEndResult) =>
    task ? withChildSpend(ctx.session, ended) : Effect.succeed(ended);
  // A stop asked before the run was reachable is this fiber's interruption,
  // taken before the loop does any work.
  return Effect.suspend(() =>
    variant.kind === 'resume' && variant.isCancellationRequested?.()
      ? Effect.interrupt
      : runToolUse({
          turns: shared.turns,
          resume: variant.kind === 'resume',
          attachment: handle,
        }),
  ).pipe(
    Effect.flatMap(withChildrenSpend),
    Effect.provide(
      runLayerFor(
        ctx,
        shared,
        variant.kind === 'resume' ? variant.onIdle : undefined,
      ),
    ),
  );
}

/** Toast payload shown when the progress view cannot be opened. */
type FallbackNotification = NonNullable<
  RequestEnsureProgressViewPayload['fallbackNotification']
>;

function buildFallbackNotification(config: AgentConfig): FallbackNotification {
  const primaryInput = config.inputFiles[0];
  const inputName = primaryInput
    ? path.basename(primaryInput)
    : 'selected input';
  const { outputFiles } = config;
  let outputInfo = '';
  if (outputFiles.length > 1) {
    outputInfo = `to ${outputFiles.length} files`;
  } else if (outputFiles[0]) {
    outputInfo = `to ${path.basename(outputFiles[0])}`;
  }
  return {
    agentName: config.agent,
    modelName: config.model,
    inputName,
    outputInfo,
  };
}

/** Callback and host-context fields shared by every entry point that drives
 *  one subagent run (`executeAgent`, `resumeToolUseFromResumeData`). */
interface SubagentRunOptions {
  /** The child-run policy: each turn's permit, each turn's settlement. */
  readonly turns?: ChildRunTurns<RunEndResult>;
  /** Run-scoped tools added to the agent without mutating the default registry. */
  readonly tools?: readonly ITool[];
  /**
   * The launching run, for a delegated child: the parent edge on the handle,
   * the subagent prompt. A fresh launch takes it from the caller; a resume ignores it and
   * reads the persisted `run.start`.
   */
  parentRunId?: RunId;
  /** Fires on meaningful progress: plan changes and tool call milestones. */
  onProgress?: (update: SubagentProgressUpdate) => void;
  /** Session owning this run's coordination state. */
  readonly session: SessionHandle;
  /** Fires once with the run's id right after its handle is tracked. */
  onRun?: (runId: RunId) => Effect.Effect<void, Error>;
}

/** Options for executeAgent. */
export interface ExecuteAgentOptions extends SubagentRunOptions {
  /** The run's registration, which its opening batch commits: the run is
   *  born with its opening or not at all. */
  readonly registration: RegisterRunOptions;
  /**
   * The one admission hook, once per caller, with the run admitted. A fresh
   * launch runs it as its opening commits, which it holds: keep it short (a
   * failure warns; the run goes on). A resume, or a joiner once the resume
   * has the run, runs it under the claim; a failure aborts that one.
   */
  onAdmitted?: (runId: RunId) => Effect.Effect<void, Error>;
  /** Stop a tool-use run after one model/tool cycle instead of waiting for follow-up input. */
  stopAfterCycle?: boolean;
}

/**
 * Low-level runner for a fresh run: it registers the run with its opening
 * (`options.registration`). Launches should use `Runs.launch({ request, options })`; a resume
 * goes through `resumeToolUseFromResumeData`. The run is on
 * `options.session`, and so are its `Runs`, provided here.
 */
export function executeAgent(
  definition: PreparedAgentDefinition,
  runId: RunId,
  options: ExecuteAgentOptions,
): Effect.Effect<RunEndResult, Error, ProcessServices> {
  return Effect.gen(function* () {
    // Done once the run exists: its description is a row of it.
    const opened = yield* Deferred.make<void>();
    const ctx = yield* buildAgentLaunchContext({
      definition,
      runId,
      registration: options.registration,
      onAdmitted: (resolved) =>
        Deferred.succeed(opened, undefined).pipe(
          Effect.andThen(options.onAdmitted?.(resolved) ?? Effect.void),
          Effect.catch((error) =>
            Effect.logWarning(`Run ${resolved}'s admission failed`).pipe(
              Effect.annotateLogs({ data: error }),
            ),
          ),
        ),
      session: options.session,
      toolPolicy: { stopAfterCycle: options.stopAfterCycle },
    });
    const { config, session: runSession } = ctx;

    // Start description generation concurrently with the run, and settle
    // it before the run ends (`settleDescriptionOnExit`), so the metadata
    // write cannot recreate a run deleted by another host.
    // A child of the run's fiber, so the run's stop interrupts it, as it
    // interrupts the run.
    const sessionDescription = yield* Effect.forkChild(
      Deferred.await(opened).pipe(
        Effect.andThen(
          generateSessionDescription(
            runId,
            config,
            ctx.resolvedAgentDescription,
            runSession,
            ctx.stores,
          ),
        ),
      ),
    );
    // The backstop wait is `ensuring`, not a generator `finally`: the driver
    // skips a `finally` after a failed `yield*`, ending the run early.
    return yield* runWithLifecycle(
      ctx,
      (handle) =>
        Effect.gen(function* () {
          // This run's parent edge now: a detach during preparation
          // promoted it to a top-level run.
          const parentRunId = runSession.runs.get(runId)?.parent ?? undefined;
          // The run directory is created by the first write into it.
          yield* Effect.logInfo(`Starting run (runId: ${runId})`).pipe(
            Effect.annotateLogs({
              data: {
                agent: config.agent,
                model: config.model,
                input: config.inputFiles[0] ?? '(none)',
                outputs: config.outputFiles.length,
              },
            }),
            withLogChannel(CHANNEL),
          );
          // Subagents don't need to force-open the progress board or show notifications;
          // the orchestrator's run is already visible.
          if (parentRunId === undefined) {
            yield* runSession.interactions.emit(
              'requestEnsureProgressView',
              {
                fallbackNotification: buildFallbackNotification(config),
              },
              { replayWhenAttached: true },
            );
          }
          return yield* launchRun(ctx, handle, options, { kind: 'fresh' });
        }).pipe(settleDescriptionOnExit(sessionDescription, opened)),
      // The edge the lifecycle's handle is born with: the caller's own
      // parent for a fresh child.
      {
        parentRunId: options.parentRunId,
        onRun: options.onRun,
        finishLastTurn: options.turns?.finishLastTurn,
      },
    ).pipe(Effect.ensuring(Fiber.await(sessionDescription)));
  }).pipe(
    // The run's scope: the launch acquires the run trace into it and the
    // finalizer drops its subscribers once the run has ended. No mask: the
    // launch's acquisitions settle atomically (`acquireRelease`), so an
    // interruption lands between steps and this scope's finalizers run.
    Effect.scoped,
    Effect.provideService(Runs, options.session.runs),
  );
}

/**
 * What a resumed turn is handed: which run, and the config it runs under.
 * The snapshot is not part of it — the turn reads it once, under the run
 * lease it just acquired, so no caller can hand in a stale one.
 */
export interface ResumeTurnIdentity {
  readonly runId: RunId;
  /** The run's configuration, as its newest `run.config` holds it. */
  readonly agentConfig: AgentConfig;
}

/** What a fresh launch takes, but its registration. */
export interface ResumeToolUseFromResumeDataOptions extends Omit<
  ExecuteAgentOptions,
  'registration'
> {
  /** A resumed cycle is idle after its child delivery, while its run stays live. */
  readonly onIdle?: () => void;
  /** Caller-owned cancellation, read on the run's fiber before its loop. */
  readonly isCancellationRequested?: () => boolean;
}

/**
 * Resume one run (a conversation, or a task's recipe) from its
 * durable cursor, in place: standalone through the session's door
 * (`Runs.resume`), owned for its life by the launch terminal
 * ({@link runWithLaunchGuard}, its claim held before the cursor read), or
 * inside a recovered child's continuous driver (`options.turns`). Lineage is
 * `run.start.parent`, minus a committed detach.
 */
export function resumeToolUseFromResumeData(
  identity: ResumeTurnIdentity,
  options: ResumeToolUseFromResumeDataOptions,
): Effect.Effect<RunEndResult, Error, ProcessServices> {
  const { session: runSession, stopAfterCycle } = options;
  const resumed = Effect.gen(function* () {
    if (!(yield* canResume(identity.runId, runSession)))
      return yield* new ResumeSessionUnavailableError({
        runId: identity.runId,
      });
    const parentRunId = yield* persistedParentRunId(runSession, identity.runId);
    const definition = yield* prepareAgentDefinition({
      config: identity.agentConfig,
      session: runSession,
      suppressErrorNotification: true,
    });
    const ctx = yield* buildAgentLaunchContext({
      definition,
      runId: identity.runId,
      session: runSession,
      toolPolicy: { stopAfterCycle },
    });
    return yield* runWithLifecycle(
      ctx,
      (handle) =>
        launchRun(ctx, handle, options, {
          kind: 'resume',
          onIdle: options.onIdle,
          isCancellationRequested: options.isCancellationRequested,
        }),
      // Resume reads the parent edge from the persisted `run.start`.
      {
        parentRunId,
        onRun: options.onRun,
        finishLastTurn: options.turns?.finishLastTurn,
      },
    );
  }).pipe(Effect.scoped);
  return (
    options.turns
      ? resumed
      : runWithLaunchGuard(runSession, identity.runId, resumed, true)
  ).pipe(Effect.provideService(Runs, runSession.runs));
}
