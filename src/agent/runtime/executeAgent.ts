import * as path from 'node:path';

import { Cause, Effect, Exit, Fiber, Layer } from 'effect';

import type { AgentEvent, AgentTrace } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';
import { persistedParentRunId } from '@agent/storage/runRecords';
import { withLogChannel } from '@logger/effectLog';
import type { ProcessServices } from '@platform/processRuntime';
import { sessionFsLayer } from '@platform/rootedFs';
import {
  type RunId,
  type RequestEnsureProgressViewPayload,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import {
  AgentCategory,
  RUN_OUTCOME,
  roundOutputsToCompileFailureSummaries,
  roundOutputsToOutputSummaries,
} from '@shared/schemas';
import { RunLedger } from '@shared/session/runLedger';
import type { CompositionKey } from '@tools/compositions';
import { aggregateError } from '@utils/core';
import { ensureError } from '@utils/errors/errorMessage';
import { ensureRunDirUnder } from '@utils/files/runStorageFs';

import {
  buildAgentLaunchContext,
  prepareAgentDefinition,
  type PreparedAgentDefinition,
  type AgentLaunchContext,
} from './AgentLaunchContext';
import {
  runFlowWithLifecycle,
  type RunFlowLifecycleOptions,
} from './AgentRunLifecycle';
import {
  type AgentFlowResult,
  type WorkflowFlowResult,
} from './AgentFlowResult';
import {
  generateSessionDescription,
  settleDescriptionOnExit,
} from './sessionDescription';
import {
  retrieveSessionResumeData,
  type ResumeData,
} from './SessionResumeRetrieval';
import { modelInvokerLayer } from './ModelInvoker';
import { agentRunLayer, withCompositionHash } from './run/AgentRun';
import { runToolUse } from './loop/toolUse';
import { Runs } from './runRegistry';
import type { AgentRunServices } from './runRegistry';
import type { SessionHandle } from './SessionHandle';
import type { RunHandle } from './RunHandle';

const CHANNEL = 'executeAgent';

/** A claimed run no longer has the persisted state to resume. */
export class ResumeSessionUnavailableError extends Error {
  constructor(readonly runId: RunId) {
    super('This session can no longer be resumed. Start a new run instead.');
    this.name = 'ResumeSessionUnavailableError';
  }
}

/**
 * The wiring the two tool-use entry points genuinely do not share. Everything
 * outside this union is assembled once in {@link launchToolUseRun}, so a field
 * added for one entry point cannot go missing on the other.
 */
type ToolUseLaunchVariant =
  | {
      readonly kind: 'fresh';
      readonly onIdle?: () => void;
    }
  | {
      readonly kind: 'resume';
      readonly onIdle?: () => void;
      /** Queried once the resumed flow is attached and interruptible. */
      readonly isCancellationRequested?: () => boolean;
      readonly onCancellationAtFlowAttachment?: () => void;
    };

/**
 * The per-run layer both families run under: the run's `AgentRun`, the
 * invoker, the session's ledger, and the session's rooted filesystems (built
 * from the roots of the session the run is on, fresh or resumed, so code
 * below the launch takes `WorkspaceFs` / `StorageFs` from context rather than
 * from the fiber's ambient roots). The follow-up lease is not here: a
 * conversation claims its own inside the loop (`claimFollowUps`), and a
 * workflow run's rounds take no input.
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
        onApprovalPolicyDenial: shared.onApprovalPolicyDenial,
        callbacks: {
          onProgress: (update) => {
            // A UI-only signal, suppressed in the transcript fold: the session
            // progress projector derives `updateConversationProgress` from it.
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
    Layer.provideMerge(Layer.succeed(RunLedger)(runSession.ledger)),
    Layer.provideMerge(sessionFsLayer(runSession.roots)),
  );
}

/**
 * Run the tool-use loop for a single agent run, fresh or resumed.
 *
 * Owns all tool-use-specific wiring: progress counters and model-change side
 * effects. A failed run arrives as a FAILED result carrying
 * its structured error, so there is nothing to unwrap here.
 * The callers (`executeAgent`, `resumeToolUseFromResumeData`) own lifecycle and
 * stream-status; this function owns only what is specific to the ToolUse
 * category.
 */
function launchToolUseRun(
  ctx: AgentLaunchContext,
  handle: RunHandle,
  shared: SubagentRunOptions,
  variant: ToolUseLaunchVariant,
): Effect.Effect<AgentFlowResult, Error, AgentRunServices> {
  const toResult = (
    result: Effect.Success<ReturnType<typeof runToolUse>>,
  ): AgentFlowResult => ({
    outcome: result.outcome,
    output: {
      category: 'toolUse',
      response: result.response,
      files: [...result.files],
      ...(result.structured !== undefined
        ? { structured: result.structured }
        : {}),
    },
    runId: ctx.runId,
    usage: result.usage,
    ...(result.error ? { error: result.error } : {}),
    ...(ctx.attachedMemoryMisses.length
      ? { memoryMisses: ctx.attachedMemoryMisses }
      : {}),
  });
  return runToolUse({
    ...(shared.turns
      ? {
          turns: {
            turnPermit: shared.turns.turnPermit,
            onTurnBoundary: (result) =>
              shared.turns!.onTurnBoundary(toResult(result)),
          },
        }
      : {}),
    resume: variant.kind === 'resume',
    attachment: {
      attach: (flowContext) => {
        handle.attachToolUseFlow(flowContext);
        if (variant.kind === 'resume' && variant.isCancellationRequested?.()) {
          variant.onCancellationAtFlowAttachment?.();
          flowContext.interrupt();
        }
      },
      detach: (flowContext) => handle.detachToolUseFlow(flowContext),
    },
  }).pipe(
    Effect.map(toResult),
    withCompositionHash,
    Effect.provide(runLayerFor(ctx, shared, variant.onIdle)),
  );
}

/**
 * A workflow agent, in round mode. The host publishes its output before the
 * run's terminal commit and reports whether that worked; the verdict stays
 * this function's. A child's one turn wraps it all.
 */
function launchWorkflowRun(
  ctx: AgentLaunchContext,
  options: SubagentRunOptions &
    Pick<ExecuteAgentOptions, 'publishWorkflowOutput'>,
  resumed: boolean,
): Effect.Effect<AgentFlowResult, Error, AgentRunServices> {
  const start = { resume: resumed };
  const program = Effect.gen(function* () {
    const result = yield* withCompositionHash(runToolUse(start)).pipe(
      Effect.provide(runLayerFor(ctx, options, undefined)),
    );
    const flowResult: WorkflowFlowResult = {
      outcome: result.outcome,
      output: {
        category: 'workflow',
        outputs: roundOutputsToOutputSummaries(result.roundOutputs),
        compileFailures: roundOutputsToCompileFailureSummaries(
          result.roundOutputs,
        ),
        diffs: [],
      },
      runId: ctx.runId,
      usage: result.usage,
      ...(result.error ? { error: result.error } : {}),
      ...(ctx.attachedMemoryMisses?.length
        ? { memoryMisses: ctx.attachedMemoryMisses }
        : {}),
      compositionHash: result.compositionHash,
    };
    if (flowResult.error || !options.publishWorkflowOutput) return flowResult;
    const publication = yield* options.publishWorkflowOutput(
      flowResult,
      ctx.setting.defaultOutputFiles,
    );
    // Output the user asked for and did not get fails the run; a stop still
    // reads as the stop it was.
    return publication === 'failed' &&
      flowResult.outcome !== RUN_OUTCOME.CANCELLED
      ? { ...flowResult, outcome: RUN_OUTCOME.FAILED }
      : flowResult;
  });
  return options.turns ? options.turns.turnPermit(program) : program;
}

/**
 * The lifecycle options every entry point that drives one run passes. The
 * parent edge is an argument because resume reads it from the persisted
 * `run.start` rather than from the caller's options.
 */
function buildLifecycleOptions(
  options: SubagentRunOptions,
  parentRunId: RunId | undefined,
): RunFlowLifecycleOptions {
  return {
    parentRunId,
    onRun: options.onRun,
  };
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
  const outputFiles = config.outputFiles ?? [];
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

/**
 * Callback and host-context fields shared by every entry point that drives one
 * subagent run (`executeAgent`, `resumeToolUseFromResumeData`, and
 * `resumeQueuedToolUseFromResumeData`). Extracted so the three option bags describing
 * the same run can't silently drift out of sync or re-declare the same field
 * under a different name.
 */
interface SubagentRunOptions {
  /** The child-run policy: each turn's permit, each completed turn's boundary. */
  readonly turns?: import('./childRunLoop').ChildRunTurns<AgentFlowResult>;
  /** Run-scoped tools added to tool-use agents without mutating the default registry. */
  readonly tools?: readonly ITool[];
  /**
   * The launching run, for a delegated child: the parent edge on the handle,
   * the subagent prompt. A fresh launch takes it from the caller; a resume ignores it and
   * reads the persisted `run.start`.
   */
  parentRunId?: RunId;
  /** Fires on meaningful progress: todo changes and tool call milestones. */
  onProgress?: (update: SubagentProgressUpdate) => void;
  /** Hide tools whose approval prompts cannot be answered in this host mode. */
  approvalPromptsUnavailable?: boolean;
  /**
   * The composition a fresh delegated child joins: its parent's. A resume
   * resolves its own under the recorded-toolset rule.
   */
  composition?: CompositionKey;
  /** Record that this run met an approval-policy denial (see `AgentRun`). */
  onApprovalPolicyDenial?: import('./run/AgentRun').AgentRunShape['onApprovalPolicyDenial'];
  /** Session owning this run's coordination state; run entry points require it. */
  session?: SessionHandle;
  /** Fires once with the run's id right after its handle is tracked (F-2). */
  onRun?: (runId: RunId) => Effect.Effect<void, Error>;
}

/** Options for executeAgent. */
export interface ExecuteAgentOptions extends SubagentRunOptions {
  /**
   * Publish a workflow's host-owned output (copies to user-requested
   * destinations, the result record) while its run handle and durable
   * checkpoint are still live, before the run's terminal commit. A stop
   * during this operation can therefore preserve the checkpoint instead of
   * interrupting an already-terminal run.
   *
   * The host reports a fact, `failed` when requested output could not be
   * delivered, and the run decides its verdict from it; the host never
   * names an outcome. Presentation (opening the final output) is not
   * publication: a host does it after the launch returns, from the result.
   *
   * The run yields this program on the run's own fiber, so a stop reaches
   * it. A handler that needs a session-rooted fact (workspace config,
   * storage) reads it from the session it was given, not from the calling
   * fiber: nothing carries one.
   */
  publishWorkflowOutput?: (
    result: WorkflowFlowResult,
    /**
     * The `defaultOutputFiles` declared by the definition this run loaded —
     * the only place a remote agent's are readable, and the run's own copy, so
     * a host never re-reads a catalog entry that may have been refreshed since
     * the launch.
     */
    agentDefaultOutputFiles: readonly string[],
  ) => Effect.Effect<'published' | 'failed', Error>;
  /**
   * Fires with the run id once its `run.start` is published, before the run
   * begins: the run exists for every fold, so a host may select it as its
   * own surface state.
   */
  onRunResolved?: (runId: RunId) => void;
  /** A sink of every event the run's trace emits, beside the session's
   *  (`AgentLaunchContext.onTraceEvent`). */
  onTraceEvent?: (event: AgentEvent) => void;
  /** Fires at every cycle boundary — see `AgentRun.callbacks.onIdle`. */
  onIdle?: () => void;
  /** Stop a tool-use run after one model/tool cycle instead of waiting for follow-up input. */
  stopAfterCycle?: boolean;
  /** This launch is the user's own-API-key fallback for a quota-exhausted
   *  retry: it declines the Copilot route and every subscription route. */
  ownApiKeyFallback?: boolean;
}

/**
 * Low-level runner for a freshly registered run. Launches should use
 * `runAgent()` or call `registerRun()` first so the canonical configuration
 * is committed with the run's creation. Its prepared definition must be the
 * one registration used; a resume goes through `resumeToolUseFromResumeData`.
 * The run is on `options.session`, and so are its `Runs`, provided here.
 */
export function executeAgent(
  definition: PreparedAgentDefinition,
  runId: RunId,
  options: ExecuteAgentOptions & { session: SessionHandle },
): Effect.Effect<AgentFlowResult, Error, ProcessServices> {
  return Effect.gen(function* () {
    const ctx = yield* buildAgentLaunchContext({
      definition,
      runId,
      onRunResolved: options.onRunResolved,
      onTraceEvent: options.onTraceEvent,
      session: options.session,
      ownApiKeyFallback: options.ownApiKeyFallback,
      toolPolicy: {
        approvalPromptsUnavailable: options.approvalPromptsUnavailable,
        stopAfterCycle: options.stopAfterCycle,
        composition: options.composition,
      },
    });
    return yield* Effect.gen(function* () {
      const { setting, config } = ctx;
      const { runId, session: runSession } = ctx;

      // Start description generation concurrently with the run, and settle
      // it before the run ends (`settleDescriptionOnExit`), so the metadata
      // write cannot recreate a run deleted by another host.
      // A child of the run's fiber, so the run's stop interrupts it, as it
      // interrupts the run.
      const sessionDescription = yield* Effect.forkChild(
        generateSessionDescription(
          runId,
          config,
          ctx.resolvedAgentDescription,
          runSession,
          ctx.stores,
        ),
      );
      // The backstop wait is `ensuring`, not a generator `finally`: the driver
      // skips a `finally` after a failed `yield*`, ending the run early.
      return yield* runFlowWithLifecycle(
        ctx,
        (handle) =>
          Effect.gen(function* () {
            // This run's lineage, derived once, from the live handle the
            // registry admitted: the caller's own parent.
            const parentRunId = handle.parent ?? undefined;
            // Pre-run UI setup (RUNNING is set by runFlowWithLifecycle)
            yield* ensureRunDirUnder(runSession.roots.storage, runId);
            yield* Effect.logInfo(`Starting run (runId: ${runId})`).pipe(
              withLogChannel(CHANNEL),
            );
            yield* Effect.logInfo(
              `Input file: ${config.inputFiles[0] ?? '(none)'}`,
            ).pipe(withLogChannel(CHANNEL));
            yield* Effect.logDebug('Run details').pipe(
              Effect.annotateLogs({
                data: {
                  runId,
                  agent: config.agent,
                  model: config.model,
                },
              }),
              withLogChannel(CHANNEL),
            );
            yield* Effect.logDebug(
              `Output files: ${config.outputFiles?.length ?? 0}`,
            ).pipe(withLogChannel(CHANNEL));
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
            yield* Effect.logInfo('Executing agent').pipe(
              Effect.annotateLogs({
                data: { agent: config.agent, model: config.model },
              }),
              withLogChannel(CHANNEL),
            );

            if (setting.agentCategory === AgentCategory.ToolUse) {
              return yield* launchToolUseRun(
                ctx,
                handle,
                { ...options, parentRunId },
                { kind: 'fresh', onIdle: options.onIdle },
              );
            }
            return yield* launchWorkflowRun(
              ctx,
              { ...options, parentRunId },
              false,
            );
          }).pipe(settleDescriptionOnExit(sessionDescription)),
        // The edge the lifecycle's handle is born with: the caller's own
        // parent for a fresh child.
        buildLifecycleOptions(options, options.parentRunId),
      ).pipe(Effect.ensuring(Fiber.await(sessionDescription)));
    });
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
export type ResumeTurnIdentity = Pick<ResumeData, 'runId' | 'agentConfig'>;

export interface ResumeToolUseFromResumeDataOptions
  extends
    SubagentRunOptions,
    Pick<ExecuteAgentOptions, 'publishWorkflowOutput'> {
  /** A resumed cycle is idle after its child delivery, while its run stays live. */
  readonly onIdle?: () => void;
  /** Query caller-owned cancellation once the resumed flow is interruptible. */
  readonly isCancellationRequested?: () => boolean;
  /** Observe cancellation accepted at the live-flow attachment boundary. */
  readonly onCancellationAtFlowAttachment?: () => void;
  /** Fires once a standalone resume holds the run's claim. */
  readonly onRunClaimed?: (runId: RunId) => void;
  /**
   * Host-owned final state, persisted before the run's ending commits; true
   * when the hook committed that ending itself (`commitRunEnd`). Its failure
   * is one more failure reported, never a `false`: the ending still commits.
   */
  readonly beforeRunEnd?: (
    session: SessionHandle,
  ) => Effect.Effect<boolean | void, Error>;
}

/**
 * Resume one live run, a conversation or a workflow in round mode, from its
 * durable cursor. Lineage is `run.start.parent`, minus a committed detach.
 */
const resumeToolUseWithOwnedLease = Effect.fn('resumeToolUseWithOwnedLease')(
  function* (
    resume: ResumeData,
    options: ResumeToolUseFromResumeDataOptions & { session: SessionHandle },
  ) {
    const runSession = options.session;
    // Every exit escapes this scope before the claim's release runs (the
    // scope `resumeToolUse` closes around this call): the launch's finalizers
    // compensate through the run's own claim - the stage's FAILED close is an
    // append - so a release that ran before them would have their
    // compensation refused `DatabaseNotOwner`.
    const outcome = yield* Effect.exit(
      Effect.scoped(
        Effect.gen(function* () {
          const parentRunId = yield* persistedParentRunId(
            runSession,
            resume.runId,
          );
          const definition = yield* prepareAgentDefinition({
            config: resume.agentConfig,
            enforceCategory: true,
            session: runSession,
            suppressErrorNotification: true,
          });
          const ctx = yield* buildAgentLaunchContext({
            definition,
            runId: resume.runId,
            resumed: true,
            modelCompatibilityKey: resume.modelCompatibilityKey,
            session: runSession,
            toolPolicy: {
              approvalPromptsUnavailable: options.approvalPromptsUnavailable,
            },
          });
          return yield* runFlowWithLifecycle(
            ctx,
            (handle) =>
              ctx.setting.agentCategory === AgentCategory.Workflow
                ? launchWorkflowRun(ctx, { ...options, parentRunId }, true)
                : launchToolUseRun(
                    ctx,
                    handle,
                    { ...options, parentRunId },
                    {
                      kind: 'resume',
                      onIdle: options.onIdle,
                      isCancellationRequested: options.isCancellationRequested,
                      onCancellationAtFlowAttachment:
                        options.onCancellationAtFlowAttachment,
                    },
                  ),
            buildLifecycleOptions(options, parentRunId),
          );
        }),
      ),
    );
    // The claim's release is no longer this function's: it rides the scope
    // `resumeToolUse` closes around this call, and for a recovered child the
    // driver owns delivery and releases afterwards.
    return yield* outcome;
  },
);

/** Acquire a recovered run and reload its cursor before starting its live scope. */
const resumeToolUse = Effect.fn('resumeToolUse')(function* (
  identity: ResumeTurnIdentity,
  options: ResumeToolUseFromResumeDataOptions & { session: SessionHandle },
) {
  const session = options.session;
  // The claim's lifetime is the whole resume, as one `acquireRelease`:
  // acquired before the cursor read so no concurrent owner mutates the run
  // between the read and the launch, released when this scope closes — after
  // the launch's own scope and its compensating finalizers, never before
  // them, and on every exit the old rollback/release pair covered.
  // A release finalizer cannot fail, and a failed claim release is no
  // defect either — a drain that lost queued facts is the caller's typed
  // error. The finalizer records it and the fold after the scope re-fails:
  // alone after a successful turn, aggregated behind the run's own failure
  // otherwise, the run's first — `Effect.onExit`-style combining would bury
  // it instead.
  let releaseFailure: Error | undefined;
  const outcome = yield* Effect.exit(
    Effect.scoped(
      Effect.gen(function* () {
        // A recovered child's continuous driver holds the claim already; a
        // standalone resume takes it here.
        if (!options.turns) {
          yield* session.holdRunClaim(identity.runId);
          options.onRunClaimed?.(identity.runId);
          // Registered after the hold, so it runs before the hold's release:
          // the run's ending commits under the claim it is written with,
          // unless the host's own final step already committed it.
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              const failures: unknown[] = [];
              const artifacts = yield* Effect.exit(
                Effect.suspend(
                  () => options.beforeRunEnd?.(session) ?? Effect.void,
                ),
              );
              if (Exit.isFailure(artifacts))
                failures.push(Cause.squash(artifacts.cause));
              if (Exit.isFailure(artifacts) || artifacts.value !== true) {
                const ended = yield* Effect.exit(
                  session.commitRunEnd(identity.runId),
                );
                if (Exit.isFailure(ended))
                  failures.push(Cause.squash(ended.cause));
              }
              if (failures.length > 0)
                releaseFailure = ensureError(
                  aggregateError(failures, 'The run could not be ended'),
                );
            }),
          );
        }
        const retrieved = yield* retrieveSessionResumeData(
          identity.runId,
          identity.agentConfig,
          session,
        ).pipe(
          Effect.flatMap((retrieved) =>
            retrieved
              ? Effect.succeed(retrieved)
              : Effect.fail(new ResumeSessionUnavailableError(identity.runId)),
          ),
        );
        // The launched turn owns the run from here, including setup failures.
        return yield* resumeToolUseWithOwnedLease(retrieved, options);
      }),
    ),
  );
  if (Exit.isSuccess(outcome)) {
    if (releaseFailure !== undefined) return yield* Effect.fail(releaseFailure);
    return outcome.value;
  }
  // An interruption unwinds straight past the fold; nothing aggregates
  // behind it.
  if (releaseFailure === undefined || Cause.hasInterruptsOnly(outcome.cause))
    return yield* Effect.failCause(outcome.cause);
  return yield* Effect.fail(
    new AggregateError(
      [ensureError(Cause.squash(outcome.cause)), releaseFailure],
      `Run ${identity.runId} failed and its final artifacts could not be persisted`,
    ),
  );
});

/** Resume after the previous generation and its teardown have settled, on
 *  the `Runs` of `options.session`. */
export function resumeToolUseFromResumeData(
  identity: ResumeTurnIdentity,
  options: ResumeToolUseFromResumeDataOptions & { session: SessionHandle },
): Effect.Effect<AgentFlowResult, Error, ProcessServices> {
  const { runs } = options.session;
  // A recovered child's continuous driver already holds this run lane.
  // Standalone host roots acquire it here; neither path launches a second owner.
  const program = resumeToolUse(identity, options);
  return (
    options.turns ? program : runs.launchRun(identity.runId, program)
  ).pipe(Effect.provideService(Runs, runs));
}
