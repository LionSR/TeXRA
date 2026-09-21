import * as path from 'node:path';

import { Cause, Deferred, Effect, Exit, Fiber, Layer } from 'effect';

import { logConversationProgress, type AgentTrace } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';
import { acquireResumedRunOwnership } from '@agent/storage/runLifecycle';
import { persistedParentRunId } from '@agent/storage/runRecords';
import { AgentError } from '@common/errors';
import { createLog } from '@logger/logUtils';
import type { ProcessServices } from '@platform/processRuntime';
import { sessionFsLayer } from '@platform/rootedFs';
import {
  type ModelCompatibilityKey,
  type RunId,
  type RequestEnsureProgressViewPayload,
  type RunOutcome,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import {
  AgentCategory,
  RUN_OUTCOME,
  roundOutputsToCompileFailureSummaries,
  roundOutputsToOutputSummaries,
} from '@shared/schemas';
import { RunLedger } from '@shared/session/runLedger';
import { emptyRunEndOutput } from '@shared/schemas';
import { provideAgentEngine } from '@tools/delegation/nativeSubagentStrategy';
import { LeanLanguageServices } from '@tools/lean/leanLanguageServices';
import { ensureRunDirUnder } from '@utils/files/runStorageFs';
import { ensureError } from '@utils/errors/errorMessage';

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
  isWaitingFlowResult,
  type AgentRuntimeFlowResult,
  type WaitingToolUseFlowResult,
  type AgentFlowResult,
  type WorkflowFlowResult,
} from './AgentFlowResult';
import { generateSessionDescription } from './sessionDescription';
import {
  retrieveSessionResumeData,
  type ToolUseResumeData,
} from './SessionResumeRetrieval';
import { followUpsLayer } from './FollowUps';
import { modelInvokerLayer } from './ModelInvoker';
import { agentRunLayer } from './run/AgentRun';
import { runReflection } from './loop/reflection';
import { runToolUse } from './loop/toolUse';
import { Runs } from './runRegistry';
import type { AgentRunServices } from './toolInjection';
import type { SessionHandle } from './SessionHandle';
import type { RunHandle, AgentRunHandle } from './RunHandle';

const logger = createLog('executeAgent');

/** A claimed run no longer has the persisted tool-use state to resume. */
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
      /** Root-run-only; resume has no caller-supplied equivalent. */
      readonly onIdle?: () => void;
    }
  | {
      readonly kind: 'resume';
      readonly resume: ToolUseResumeData;
      /** Queried once the resumed flow is attached and interruptible. */
      readonly isCancellationRequested?: () => boolean;
      readonly onCancellationAtFlowAttachment?: () => void;
    };

/**
 * The per-run layer both families run under: the run's `AgentRun`, the
 * invoker, the session's ledger, and the session's rooted filesystems (built
 * from the roots of the session the run is on, fresh or resumed, so code
 * below the launch takes `WorkspaceFs` / `StorageFs` from context rather than
 * from the fiber's ambient roots). The follow-up lease is not here: only
 * the tool-use loop consumes a queue and only its finalizer releases the
 * lease, so building `followUpsLayer` for a workflow run would claim a live
 * consumer nothing ever releases — later submissions would report as
 * delivered live to a run that has ended.
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
        parentRunId: shared.parentRunId ?? null,
        tools: shared.tools,
        onApprovalPolicyDenial: shared.onApprovalPolicyDenial,
        callbacks: {
          onProgress: (update) => {
            if (update.kind === 'overview') {
              logConversationProgress(ctx.logger, {
                toolCallCount: update.toolCallCount,
              });
            }
            shared.onProgress?.(update);
          },
          onModelChanged: (model) => {
            // The cell is the live model; usage accounting and the prompt
            // side MODEL variable read it directly. This one mirror remains
            // because config.model is a persisted AgentConfig schema field.
            ctx.config.model = model;
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
 * The one boundary that races the run's stop. `ctx.stopped` is completed by
 * every stop entry (a host kill through the run handle, the live tool-use
 * flow context, the launch handle's interrupt before the run has a handle of
 * its own); winning it interrupts the program's fiber, whose masked exit
 * protocol records the halt before this returns, and reports the cancelled
 * shell result of the run's category.
 * The loop reads the fiber's own interruption (`Effect.abortSignal`) for the
 * provider request and the tool bodies that still need a signal, so no run
 * signal exists beside the stop.
 */
function runUntilStopped<R>(
  ctx: AgentLaunchContext,
  program: Effect.Effect<AgentRuntimeFlowResult, Error, R>,
): Effect.Effect<AgentRuntimeFlowResult, Error, R> {
  const { runId } = ctx;
  return Effect.raceFirst(
    program.pipe(Effect.map((result) => ({ kind: 'result' as const, result }))),
    Deferred.await(ctx.stopped).pipe(Effect.as({ kind: 'stopped' as const })),
  ).pipe(
    Effect.map((winner): AgentRuntimeFlowResult => {
      if (winner.kind === 'result') return winner.result;
      return {
        outcome: RUN_OUTCOME.CANCELLED,
        output: emptyRunEndOutput(ctx.setting.agentCategory),
        runId,
        ...(ctx.attachedMemoryMisses?.length
          ? { memoryMisses: ctx.attachedMemoryMisses }
          : {}),
      };
    }),
  );
}

/**
 * Run the tool-use loop for a single agent run, fresh or resumed.
 *
 * Owns all tool-use-specific wiring: progress counters, follow-up queuing, and
 * model-change side effects. A failed run arrives as a FAILED result carrying
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
): Effect.Effect<AgentRuntimeFlowResult, Error, AgentRunServices> {
  const { runId } = ctx;
  const program = runToolUse({
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
    Effect.provide(
      // The follow-up lease is the tool-use loop's alone; its finalizer is
      // what releases it.
      followUpsLayer.pipe(
        Layer.provideMerge(
          runLayerFor(
            ctx,
            shared,
            variant.kind === 'fresh' ? variant.onIdle : undefined,
          ),
        ),
      ),
    ),
    Effect.map((result): AgentRuntimeFlowResult => ({
      outcome: result.outcome,
      output: {
        category: 'toolUse',
        response: result.response,
        files: [...result.files],
        ...(result.structured !== undefined
          ? { structured: result.structured }
          : {}),
      },
      runId,
      usage: result.usage,
      ...(result.error ? { error: result.error } : {}),
      ...(ctx.attachedMemoryMisses?.length
        ? { memoryMisses: ctx.attachedMemoryMisses }
        : {}),
    })),
  );
  return runUntilStopped(ctx, program);
}

/**
 * Run the reflection loop for a single agent run, fresh or resumed. The
 * host's output finalization runs after the loop's result and may change the
 * verdict; a run that failed keeps its error.
 */
function launchReflectionRun(
  ctx: AgentLaunchContext,
  options: ExecuteAgentOptions,
): Effect.Effect<AgentRuntimeFlowResult, Error, AgentRunServices> {
  const { runId } = ctx;
  const program = runReflection({ resume: options.resumed === true }).pipe(
    Effect.provide(runLayerFor(ctx, options, undefined)),
    Effect.flatMap((result) =>
      Effect.gen(function* () {
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
          runId,
          usage: result.usage,
          ...(result.error ? { error: result.error } : {}),
          ...(ctx.attachedMemoryMisses?.length
            ? { memoryMisses: ctx.attachedMemoryMisses }
            : {}),
        };
        if (flowResult.error || !options.openWorkflowOutput) return flowResult;
        const outputOutcome = yield* options.openWorkflowOutput(
          flowResult,
          ctx.setting.defaultOutputFiles,
        );
        return outputOutcome === undefined
          ? flowResult
          : { ...flowResult, outcome: outputOutcome };
      }),
    ),
  );
  return runUntilStopped(ctx, program);
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
    onError: options.onRunError,
    onRun: options.onRun,
    // Stop the Lean servers the ended run started; a host whose Lean
    // integration owns server lifetime (the VS Code bridge) omits the stop.
    onRunEnd: (runId) =>
      Effect.flatMap(
        LeanLanguageServices,
        (lean) => lean.stopSessionsForRun?.(runId) ?? Effect.void,
      ),
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
export interface SubagentRunOptions {
  /** Run-scoped tools added to tool-use agents without mutating the default registry. */
  readonly tools?: readonly ITool[];
  /**
   * The launching run, for a delegated child: the parent edge on the handle,
   * the subagent prompt, and the licence to park at WAITING for the child
   * loop. A fresh launch takes it from the caller; a resume ignores it and
   * reads the persisted `run.start`.
   */
  parentRunId?: RunId;
  /** Fires on meaningful progress: todo changes and tool call milestones. */
  onProgress?: (update: SubagentProgressUpdate) => void;
  /** Hide tools whose approval prompts cannot be answered in this host mode. */
  approvalPromptsUnavailable?: boolean;
  /** Record that this run encountered an executable policy denial. */
  onApprovalPolicyDenial?: () => void;
  /** Hide tools unavailable because the current host/runtime cannot support them. */
  runtimeUnavailableTools?: readonly string[];
  /** Session owning this run's coordination state; run entry points require it. */
  session?: SessionHandle;
  /**
   * Fires when a subagent fails with a provider/runtime error that the caller
   * can report up the delegation chain. Outcome-only domain failures remain on
   * the returned result and do not manufacture an error for this callback.
   * Distinct from host-level resume-plumbing error surfaces. Synchronous by
   * contract; it reaches the run's terminal `deliver` guard.
   */
  onRunError?: (error: unknown, result: AgentFlowResult) => void;
  /** Fires once with the live per-run handle right after it is tracked (F-2). */
  onRun?: (handle: AgentRunHandle) => Effect.Effect<void, Error>;
}

/** Options for executeAgent. */
export interface ExecuteAgentOptions extends SubagentRunOptions {
  /**
   * Finalize a workflow's host-owned output while its run handle and durable
   * checkpoint are still live. A stop during this operation can therefore
   * preserve the checkpoint instead of interrupting an already-terminal run.
   * Return an outcome when output finalization changes the run's verdict.
   *
   * The run yields this program on the run's own fiber, so a stop reaches
   * it. A handler that needs a session-rooted fact (workspace config,
   * storage) reads it from the session it was given, not from the calling
   * fiber: nothing carries one.
   */
  openWorkflowOutput?: (
    result: WorkflowFlowResult,
    /**
     * The `defaultOutputFiles` declared by the definition this run loaded —
     * the only place a remote agent's are readable, and the run's own copy, so
     * a host never re-reads a catalog entry that may have been refreshed since
     * the launch.
     */
    agentDefaultOutputFiles: readonly string[],
  ) => Effect.Effect<RunOutcome | void, Error>;
  /**
   * The stop latch of a launch that owns a stop before the run has a handle
   * of its own (`runAgent`'s launch handle): launch assembly fails at its
   * next step once it is completed, and the run adopts it as its one stop.
   */
  launchStopped?: Deferred.Deferred<void>;
  /**
   * The run's `run.start` was committed by an earlier activation (a resume).
   * That row is also where this run's parent edge comes from: `runAgent`
   * reads it onto the run's handle before this launch prepares, and a
   * resumed run takes its lineage from there, never from `parentRunId`.
   */
  resumed?: boolean;
  /**
   * Fires with the run id once its `run.start` is published, before the run
   * begins: the run exists for every fold, so a host may select it as its
   * own surface state. The run's trace comes with it, before its first
   * event, for a consumer that must hear every trace event.
   */
  onRunResolved?: (runId: RunId, trace: AgentTrace) => void;
  /** Root-run-only: fires at every cycle boundary — see `AgentRun.callbacks.onIdle`. */
  onIdle?: () => void;
  /** Stop a tool-use run after one model/tool cycle instead of waiting for follow-up input. */
  stopAfterCycle?: boolean;
  /** Resume using this persisted provider-message format instead of today's default route. */
  modelCompatibilityKey?: ModelCompatibilityKey | null;
  /** This launch is the user's own-API-key fallback for a quota-exhausted
   *  retry: it declines the Copilot route and every subscription route. */
  ownApiKeyFallback?: boolean;
}

// A WAITING result is reachable only for a child: `{ kind: 'waiting' }` is
// minted solely behind the tool-use loop's `parentRunId` check, which is the
// parent edge, so a caller that names a parent admits WAITING and one that
// names none never sees it. Resume paths need no flag at all — whether a
// resumed run is a child comes from the persisted `run.start`, so
// `resumeToolUseFromResumeData` always admits WAITING and callers narrow with
// `isWaitingFlowResult`.
export function executeAgent(
  definition: PreparedAgentDefinition,
  runId: RunId,
  options: ExecuteAgentOptions & {
    parentRunId: RunId;
    session: SessionHandle;
  },
): Effect.Effect<
  AgentFlowResult | WaitingToolUseFlowResult,
  Error,
  ProcessServices
>;
export function executeAgent(
  definition: PreparedAgentDefinition,
  runId: RunId,
  options: ExecuteAgentOptions & {
    parentRunId?: undefined;
    session: SessionHandle;
  },
): Effect.Effect<AgentFlowResult, Error, ProcessServices>;

/**
 * Low-level run runner for an already-registered run. Fresh
 * launches should use `runAgent()` or call `registerRun()` first so the
 * canonical configuration is committed with the run's creation.
 * Its prepared definition must be the one registration used. Resume paths reuse the existing run record.
 * The run is on `options.session`, and so are its `Runs`, provided here.
 */
export function executeAgent(
  definition: PreparedAgentDefinition,
  runId: RunId,
  options: ExecuteAgentOptions & { session: SessionHandle },
): Effect.Effect<AgentRuntimeFlowResult, Error, ProcessServices> {
  return Effect.gen(function* () {
    // A resumed run's parentage is its handle's, never the caller's word: no
    // resume caller can name one (`RunAgentOptions` has no parent field), so
    // reading the caller's option here would relaunch a resumed child as a
    // root run, forcing the progress view open, toasting its failure, and
    // shaping its result as a root's. `runAgent` put the persisted edge on
    // that handle before this launch began preparing, which is what lets the
    // parent's stop reach the child meanwhile: a stop that detaches severs
    // this very handle. The edge is deliberately not copied out here: it is
    // mutable for exactly as long as this preparation runs, so the run reads
    // it off its own lifecycle handle below, after the registry has carried
    // it across the replacement.
    const resumedHandle = options.resumed
      ? options.session.runs.getHandle(runId)
      : undefined;
    if (options.resumed && !resumedHandle) {
      return yield* Effect.fail(
        new Error(
          `Cannot resume run ${runId}: no registered handle carries its lineage.`,
        ),
      );
    }
    const ctx = yield* buildAgentLaunchContext({
      definition,
      runId,
      resumed: options.resumed,
      onRunResolved: options.onRunResolved,
      session: options.session,
      modelCompatibilityKey: options.modelCompatibilityKey,
      ownApiKeyFallback: options.ownApiKeyFallback,
      stopped: options.launchStopped,
      toolPolicy: {
        approvalPromptsUnavailable: options.approvalPromptsUnavailable,
        runtimeUnavailableTools: options.runtimeUnavailableTools,
        stopAfterCycle: options.stopAfterCycle,
      },
    });
    return yield* Effect.gen(function* () {
      const { setting, config } = ctx;
      const { runId, session: runSession } = ctx;

      // Start description generation concurrently with the run, but join it
      // before the owner can release its run lease. This prevents the
      // metadata write from recreating a run deleted by another host.
      // The run's stop interrupts it, as it interrupts the run.
      const sessionDescription = yield* Effect.forkChild(
        Effect.raceFirst(
          generateSessionDescription(
            runId,
            config,
            ctx.resolvedAgentDescription,
            runSession,
            ctx.stores,
          ),
          Deferred.await(ctx.stopped),
        ),
      );
      // The join is `ensuring`, not a generator `finally`: the driver skips
      // a `finally` after a failed `yield*`, releasing the lease mid-write.
      return yield* Effect.gen(function* () {
        const result = yield* runFlowWithLifecycle(
          ctx,
          (handle) =>
            Effect.gen(function* () {
              // This run's lineage, derived once, from the live handle
              // the registry admitted: for a resume that is the edge
              // carried over from the provisional registration, minus a
              // detach committed while the launch prepared, and for a
              // fresh launch it is the caller's own parent.
              const parentRunId = handle.deliveryTarget;
              // Pre-run UI setup (RUNNING is set by runFlowWithLifecycle)
              yield* ensureRunDirUnder(runSession.roots.storage, runId);
              logger.info(`Starting run (runId: ${runId})`);
              logger.info(`Input file: ${config.inputFiles[0] ?? '(none)'}`);
              logger.debug('Run details', {
                data: {
                  runId,
                  agent: config.agent,
                  model: config.model,
                },
              });
              logger.debug(`Output files: ${config.outputFiles?.length ?? 0}`);
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
              logger.info('Executing agent', {
                data: { agent: config.agent, model: config.model },
              });

              if (setting.agentCategory === AgentCategory.ToolUse) {
                return yield* launchToolUseRun(
                  ctx,
                  handle,
                  { ...options, parentRunId },
                  { kind: 'fresh', onIdle: options.onIdle },
                );
              }
              return yield* launchReflectionRun(ctx, {
                ...options,
                parentRunId,
              });
            }),
          // The edge the lifecycle's handle is born with, read as late
          // as that handle is built. A detach landing even after this
          // read still stands: `RunRegistry.track` carries the
          // registration's sever onto the replacement.
          buildLifecycleOptions(
            options,
            resumedHandle ? resumedHandle.deliveryTarget : options.parentRunId,
          ),
        );
        // The overload the caller chose is what admits WAITING, so this
        // assertion reads the caller's own parent, not the lineage: no
        // resume caller names one, and reading a parent off the ledger
        // must not retype a result the caller was promised is terminal.
        if (isWaitingFlowResult(result) && !options.parentRunId) {
          throw new Error(
            'executeAgent received a non-terminal WAITING result for a non-subagent run.',
          );
        }
        return result;
      }).pipe(Effect.ensuring(Fiber.join(sessionDescription)));
    });
  }).pipe(
    // The run's scope: the launch acquires the run trace into it and the
    // finalizer drops its subscribers once the run has ended.
    Effect.scoped,
    Effect.uninterruptible,
    Effect.provideService(Runs, options.session.runs),
  );
}

/**
 * What a resumed turn is handed: which run, and the config it runs under.
 * The snapshot is not part of it — the turn reads it once, under the run
 * lease it just acquired, so no caller can hand in a stale one.
 */
export type ResumeTurnIdentity = Pick<
  ToolUseResumeData,
  'runId' | 'agentConfig'
>;

export interface ResumeToolUseFromResumeDataOptions extends SubagentRunOptions {
  /** Query caller-owned cancellation once the resumed flow is interruptible. */
  readonly isCancellationRequested?: () => boolean;
  /** Observe cancellation accepted at the live-flow attachment boundary. */
  readonly onCancellationAtFlowAttachment?: () => void;
}

/**
 * Resume a persisted tool-use session at its WAITING cursor. Whether the run
 * is a child — and can therefore legitimately resolve WAITING again — is its
 * persisted parent edge (`run.start.parent`, minus a `run.detach`), never
 * the caller's word.
 */
const resumeToolUseWithOwnedLease = Effect.fn('resumeToolUseWithOwnedLease')(
  function* (
    resume: ToolUseResumeData,
    options: ResumeToolUseFromResumeDataOptions & { session: SessionHandle },
  ) {
    const runSession = options.session;
    // Every exit escapes this scope, and the release is outside it. Both
    // orders matter: the launch's finalizers compensate through the run's
    // own claim - the stage's FAILED close is an append - so a scope that
    // unwound after `releaseRunLease` would have its compensation refused
    // `DatabaseNotOwner`, and a failure captured inside the scope would
    // close it successfully, so the exit-aware finalizer would never fire.
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
              runtimeUnavailableTools: options.runtimeUnavailableTools,
            },
          });
          const { setting } = ctx;
          return yield* runFlowWithLifecycle(
            ctx,
            (handle) =>
              // Inside the lifecycle so the rejection ends the started stream
              // with its FAILED result like any other run failure.
              setting.agentCategory !== AgentCategory.ToolUse
                ? // Keep this historical diagnostic byte-for-byte for external monitors.
                  Effect.fail(
                    new AgentError(
                      'Attempted to resume a non tool-use agent with resumeToolUseFromSnapshot.',
                    ),
                  )
                : launchToolUseRun(
                    ctx,
                    handle,
                    { ...options, parentRunId },
                    {
                      kind: 'resume',
                      resume,
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
    if (Exit.isFailure(outcome)) {
      const released = yield* Effect.exit(
        runSession.releaseRunLease(resume.runId),
      );
      if (Exit.isFailure(released)) {
        return yield* Effect.fail(
          new AggregateError(
            [Cause.squash(outcome.cause), Cause.squash(released.cause)],
            `Run ${resume.runId} failed and its final artifacts could not be persisted`,
          ),
        );
      }
      return yield* Effect.failCause(outcome.cause);
    }
    // A WAITING result retains ownership for the next resumed turn.
    if (!isWaitingFlowResult(outcome.value)) {
      yield* runSession.releaseRunLease(resume.runId);
    }
    return outcome.value;
  },
  Effect.uninterruptible,
);

/**
 * One resumed turn of a persisted tool-use session: claim its run lease,
 * reload the persisted snapshot under that lease, and run. Whether the run is
 * a child — and can therefore legitimately resolve WAITING again — is its
 * persisted parent edge, never the caller's word.
 *
 * This is the inner, unserialized turn: a native child loop runs it for every
 * turn inside the child's own generation, which already holds the child's
 * run lane. Hosts resume through {@link resumeToolUseFromResumeData}.
 */
const resumeToolUseTurn = Effect.fn('resumeToolUseTurn')(function* (
  identity: ResumeTurnIdentity,
  options: ResumeToolUseFromResumeDataOptions & { session: SessionHandle },
) {
  const session = options.session;
  const rollback = yield* acquireResumedRunOwnership(session, identity.runId);
  const retrieval = yield* Effect.exit(
    retrieveSessionResumeData(
      identity.runId,
      identity.agentConfig,
      session,
    ).pipe(
      Effect.flatMap((retrieved) =>
        retrieved?.type === 'toolUse'
          ? Effect.succeed(retrieved)
          : Effect.fail(new ResumeSessionUnavailableError(identity.runId)),
      ),
    ),
  );
  if (Exit.isFailure(retrieval)) {
    const released = yield* Effect.exit(rollback);
    return yield* Effect.fail(
      Exit.isFailure(released)
        ? new AggregateError(
            [Cause.squash(retrieval.cause), Cause.squash(released.cause)],
            `Resume retrieval and admission rollback failed for ${identity.runId}`,
          )
        : ensureError(Cause.squash(retrieval.cause)),
    );
  }
  // The launched turn owns release from here, including setup failures.
  return yield* resumeToolUseWithOwnedLease(retrieval.value, options);
}, Effect.uninterruptible);

/** Resume after the previous generation and its teardown have settled, on
 *  the `Runs` of `options.session`. */
export function resumeToolUseFromResumeData(
  identity: ResumeTurnIdentity,
  options: ResumeToolUseFromResumeDataOptions & { session: SessionHandle },
): Effect.Effect<AgentRuntimeFlowResult, Error, ProcessServices> {
  const { runs } = options.session;
  return runs
    .launchRun(identity.runId, resumeToolUseTurn(identity, options))
    .pipe(Effect.provideService(Runs, runs));
}

// Close the delegation recursion: the delegation tools drive child runs
// through `nativeSubagentStrategy`, whose engine calls are provided here —
// the one direction that cannot be a static import, because this module's
// flow drivers statically import the tool registry that includes those tools.
provideAgentEngine({
  executeAgent,
  resumeToolUseTurn,
});
