import * as path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

import { Cause, Effect, Exit, Layer } from 'effect';

import { logConversationProgress, type AgentTrace } from '@agent/trace';
import type { FollowUpQueueBatchItem } from '@agent/followUp/FollowUpQueue';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { AgentSetting } from '@agent/core/definition/AgentDataclass';
import type { ITool } from '@agent/core/tools/ToolTypes';
import { acquireResumedRunOwnership } from '@agent/storage/runLifecycle';
import { getRunRecords } from '@agent/storage/RunKVStore';
import { assertOwnedRunLease } from '@agent/storage/runLease';
import { AgentError } from '@common/errors';
import { createLog } from '@logger/logUtils';
import type { CopilotRouteOverride } from '@model/copilotRouting';
import {
  aggregateId as qualifyAggregateId,
  type ModelHandlerCompatibilityKey,
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
import { stopLeanServersForEndedRun } from '@tools/lean/leanLanguageServices';
import { onAbort } from '@utils/core';
import { ensureRunDir } from '@utils/files/runStorageFs';
import { ensureError } from '@utils/errors/errorMessage';

import {
  buildAgentLaunchContext,
  prepareAgentDefinition,
  type PreparedAgentDefinition,
  withLaunchRunContext,
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
import { runInSession } from './RunContext';
import { followUpsLayer } from './FollowUps';
import { modelInvokerLayer } from './ModelInvoker';
import { agentRunLayer } from './run/AgentRun';
import { runReflection } from './loop/reflection';
import { runToolUse } from './loop/toolUse';
import {
  ToolInjectionRegistry,
  ToolInjections,
  type AgentRunServices,
} from './toolInjection';
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
      readonly drainedFollowUps?: readonly FollowUpQueueBatchItem[];
      readonly takePendingFollowUps?: () => readonly FollowUpQueueBatchItem[];
      /** Queried once the resumed flow is attached and interruptible. */
      readonly isCancellationRequested?: () => boolean;
      readonly onCancellationAtFlowAttachment?: () => void;
    };

/**
 * The per-run layer both families run under: the run's `AgentRun`, the
 * invoker, the follow-up lease, and the session's ledger.
 */
function runLayerFor(
  ctx: AgentLaunchContext,
  shared: SubagentRunOptions & {
    readonly setting: AgentSetting;
    readonly onFollowUpConsumed?: () => void;
  },
  toolInjections: ToolInjections['Service'],
  onIdle: (() => void) | undefined,
  inScope: <A>(operation: () => A) => A,
) {
  const { runId, session: runSession } = ctx.runScope;
  return Layer.mergeAll(modelInvokerLayer, followUpsLayer).pipe(
    Layer.provideMerge(
      agentRunLayer(ctx, {
        setting: shared.setting,
        parentRunId: shared.parentRunId ?? null,
        tools: shared.tools,
        toolInjections,
        inScope,
        callbacks: {
          onProgress: (update) => {
            if (update.kind === 'overview') {
              logConversationProgress(ctx.logger, {
                toolCallCount: update.toolCallCount,
              });
            }
            shared.onProgress?.(update);
          },
          onFollowUpConsumed: () => {
            runSession.publish([
              {
                type: 'updateQueuedFollowUps',
                aggregateId: qualifyAggregateId('run', runId),
                messages: runSession.followUps.getAll(runId),
              },
            ]);
            shared.onFollowUpConsumed?.();
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
  );
}

/**
 * The host's stop is the run signal. It interrupts the program's fiber,
 * whose masked exit protocol records the halt before this returns; a stop
 * that wins reports the cancelled shell result of the run's category.
 */
function raceWithStop(
  ctx: AgentLaunchContext,
  program: Effect.Effect<AgentRuntimeFlowResult, Error>,
): Effect.Effect<AgentRuntimeFlowResult, Error> {
  const { runId, signal } = ctx.runScope;
  const stopped = Effect.callback<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void);
      return;
    }
    const detach = onAbort(signal, () => resume(Effect.void));
    return Effect.sync(detach);
  });
  return Effect.raceFirst(
    program.pipe(Effect.map((result) => ({ kind: 'result' as const, result }))),
    stopped.pipe(Effect.as({ kind: 'stopped' as const })),
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
  shared: SubagentRunOptions & {
    readonly setting: AgentSetting;
    readonly onFollowUpConsumed?: () => void;
    /** The process injections the Effect-typed caller read for this run. */
    readonly toolInjections: ToolInjections['Service'];
  },
  variant: ToolUseLaunchVariant,
  inScope: <A>(operation: () => A) => A,
): Effect.Effect<AgentRuntimeFlowResult, Error> {
  const { runId } = ctx.runScope;
  const program = runToolUse({
    resume: variant.kind === 'resume',
    ...(variant.kind === 'resume'
      ? {
          drainedFollowUps: variant.drainedFollowUps,
          takePendingFollowUps: variant.takePendingFollowUps,
        }
      : {}),
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
      runLayerFor(
        ctx,
        shared,
        shared.toolInjections,
        variant.kind === 'fresh' ? variant.onIdle : undefined,
        inScope,
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
  return raceWithStop(ctx, program);
}

/**
 * Run the reflection loop for a single agent run, fresh or resumed. The
 * host's output finalization runs after the loop's result and may change the
 * verdict; a run that failed keeps its error.
 */
function launchReflectionRun(
  ctx: AgentLaunchContext,
  options: ExecuteAgentOptions & { readonly setting: AgentSetting },
  inScope: <A>(operation: () => A) => A,
): Effect.Effect<AgentRuntimeFlowResult, Error> {
  const { runId } = ctx.runScope;
  const program = runReflection({ resume: options.resumed === true }).pipe(
    // The reflection family injects no conditional tools (memory and plan are
    // tool-use infrastructure), so its run resolves tools from an empty list.
    Effect.provide(
      runLayerFor(ctx, options, new ToolInjectionRegistry(), undefined, inScope),
    ),
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
        const openWorkflowOutput = options.openWorkflowOutput;
        const outputOutcome = yield* Effect.tryPromise({
          try: () => inScope(() => openWorkflowOutput(flowResult)),
          catch: ensureError,
        });
        return outputOutcome === undefined
          ? flowResult
          : { ...flowResult, outcome: outputOutcome };
      }),
    ),
  );
  return raceWithStop(ctx, program);
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
    workflowPhase: options.workflowPhase,
    onError: options.onRunError,
    onRun: options.onRun,
    onRunEnd: (runId) => stopLeanServersForEndedRun(runId),
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
  /** Session owning this run's coordination state. Defaults to the process session. */
  session?: SessionHandle;
  /**
   * Fires when a subagent fails with a provider/runtime error that the caller
   * can report up the delegation chain. Outcome-only domain failures remain on
   * the returned result and do not manufacture an error for this callback.
   * Distinct from host-level resume-plumbing error surfaces.
   */
  onRunError?: (
    error: unknown,
    result: AgentFlowResult,
  ) => void | Promise<void>;
  /** Fires once with the live per-run handle right after it is tracked (F-2). */
  onRun?: (handle: AgentRunHandle) => void | Promise<void>;
  /**
   * Workflow-script phase owning this run, when it is an `agent()` call inside
   * a workflow script. Carried on the parent's child roster so a host can
   * group grandchild rows by phase. Not settable from `onRun` — see
   * `RunFlowLifecycleOptions.workflowPhase`.
   */
  workflowPhase?: string;
}

/** Options for executeAgent. */
export interface ExecuteAgentOptions extends SubagentRunOptions {
  /**
   * Finalize a workflow's host-owned output while its run handle and durable
   * checkpoint are still live. A stop during this operation can therefore
   * preserve the checkpoint instead of interrupting an already-terminal run.
   * Return an outcome when output finalization changes the run's verdict.
   */
  openWorkflowOutput?: (
    result: WorkflowFlowResult,
  ) => Promise<RunOutcome | void>;
  /** Cancel launch preparation before the per-run handle is available. */
  launchSignal?: AbortSignal;
  /** The run's `run.start` was committed by an earlier activation (a resume). */
  resumed?: boolean;
  /**
   * Fires with the run id once its `run.start` is published, before the run
   * begins: the run exists for every fold, so a host may select it as its
   * own surface state. The run's trace comes with it, before its first
   * event, for a consumer that must hear every trace event.
   */
  onRunResolved?: (runId: RunId, trace: AgentTrace) => void;
  /** Root-run-only: fires at every cycle boundary — see `ToolUseServices.onIdle`. */
  onIdle?: () => void;
  /** Stop a tool-use run after one model/tool cycle instead of waiting for follow-up input. */
  stopAfterCycle?: boolean;
  /** Resume using this persisted provider-message format instead of today's default route. */
  modelHandlerCompatibilityKey?: ModelHandlerCompatibilityKey | null;
  /** Deliberate one-run bypass used only by a Copilot direct-key fallback. */
  copilotRouteOverride?: CopilotRouteOverride;
}

// A WAITING result is reachable only for a child: `{ kind: 'waiting' }` is
// minted solely behind `ToolUseWaitNode`'s `parentRunId` check, which is the
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
  AgentRunServices
>;
export function executeAgent(
  definition: PreparedAgentDefinition,
  runId: RunId,
  options: ExecuteAgentOptions & {
    parentRunId?: undefined;
    session: SessionHandle;
  },
): Effect.Effect<AgentFlowResult, Error, AgentRunServices>;

/**
 * Low-level run runner for an already-registered run. Fresh
 * launches should use `runAgent()` or call `registerRun()` first so the
 * canonical configuration is committed with the run's creation.
 * Its prepared definition must be the one registration used. Resume paths reuse the existing run record.
 */
export function executeAgent(
  definition: PreparedAgentDefinition,
  runId: RunId,
  options: ExecuteAgentOptions & { session: SessionHandle },
): Effect.Effect<AgentRuntimeFlowResult, Error, AgentRunServices> {
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: async () =>
        runInSession(options.session, () => assertOwnedRunLease(runId)),
      catch: ensureError,
    });
    // Read here, on the Effect side of the lifecycle's Promise seam: the
    // flow drivers below resolve the run's tools from it.
    const toolInjections = yield* ToolInjections;
    const hasParent = options.parentRunId !== undefined;
    const ctx = yield* buildAgentLaunchContext({
      definition,
      runId,
      resumed: options.resumed,
      onRunResolved: options.onRunResolved,
      session: options.session,
      modelHandlerCompatibilityKey: options.modelHandlerCompatibilityKey,
      copilotRouteOverride: options.copilotRouteOverride,
      signal: options.launchSignal,
      toolPolicy: {
        approvalPromptsUnavailable: options.approvalPromptsUnavailable,
        runtimeUnavailableTools: options.runtimeUnavailableTools,
        stopAfterCycle: options.stopAfterCycle,
      },
    });
    return yield* Effect.suspend(() =>
      withLaunchRunContext(
        ctx,
        { onApprovalPolicyDenial: options.onApprovalPolicyDenial },
        () => {
          const runInScope = AsyncLocalStorage.bind(<A>(operation: () => A) =>
            operation(),
          );
          return Effect.gen(function* () {
            const { setting, config } = ctx;
            const { runId, session: runSession } = ctx.runScope;

            // Start description generation concurrently with the run, but join it
            // before the owner can release its run lease. This prevents the
            // metadata write from recreating a run deleted by another host.
            const sessionDescription = runInScope(() =>
              generateSessionDescription(
                runId,
                config,
                ctx.resolvedAgentDescription,
                runSession,
                ctx.stores,
                ctx.runScope.signal,
              ),
            );
            try {
              const result = yield* runFlowWithLifecycle(
                ctx,
                (handle) =>
                  Effect.gen(function* () {
                    // Pre-run UI setup (RUNNING is set by runFlowWithLifecycle)
                    yield* Effect.tryPromise({
                      try: () => runInScope(() => ensureRunDir(runId)),
                      catch: ensureError,
                    });
                    logger.info(`Starting task run (runId: ${runId})`);
                    logger.info(
                      `Input file: ${config.inputFiles[0] ?? '(none)'}`,
                    );
                    logger.debug('Task run details', {
                      data: {
                        runId,
                        agent: config.agent,
                        model: config.model,
                      },
                    });
                    logger.debug(
                      `Output files: ${config.outputFiles?.length ?? 0}`,
                    );
                    // Subagents don't need to force-open the progress board or show notifications;
                    // the orchestrator's run is already visible.
                    if (!hasParent) {
                      runSession.interactions.emit(
                        'requestEnsureProgressView',
                        {
                          fallbackNotification:
                            buildFallbackNotification(config),
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
                        { ...options, setting, toolInjections },
                        { kind: 'fresh', onIdle: options.onIdle },
                        runInScope,
                      );
                    }
                    return yield* launchReflectionRun(
                      ctx,
                      { ...options, setting },
                      runInScope,
                    );
                  }),
                buildLifecycleOptions(options, options.parentRunId),
              );
              if (isWaitingFlowResult(result) && !hasParent) {
                throw new Error(
                  'executeAgent received a non-terminal WAITING result for a non-subagent run.',
                );
              }
              return result;
            } finally {
              yield* Effect.tryPromise({
                try: () => sessionDescription,
                catch: ensureError,
              });
            }
          });
        },
      ),
    );
  }).pipe(Effect.uninterruptible);
}

export interface ResumeToolUseFromResumeDataOptions extends SubagentRunOptions {
  /** Fires when the resumed tool-use session consumes queued follow-ups. */
  readonly onFollowUpConsumed?: () => void;
  /**
   * Take messages queued after the initial drain. The flow invokes this once
   * after attaching its live context and before resuming the persisted cursor.
   */
  readonly takePendingFollowUps?: () => readonly FollowUpQueueBatchItem[];
  /** Query caller-owned cancellation once the resumed flow is interruptible. */
  readonly isCancellationRequested?: () => boolean;
  /** Observe cancellation accepted at the live-flow attachment boundary. */
  readonly onCancellationAtFlowAttachment?: () => void;
  /**
   * Follow-ups already drained by an external turn owner. The resumed flow
   * consumes this batch once at its persisted WAITING cursor; it must never
   * pass through the stream queue again.
   */
  readonly drainedFollowUps?: readonly FollowUpQueueBatchItem[];
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
    const toolInjections = yield* ToolInjections;
    const setup = yield* Effect.exit(
      Effect.gen(function* () {
        // The parent edge as the fold holds it (`run.start.parent`, severed
        // by a later `run.detach`), read cold so a resume racing the live
        // fold's first replay still sees it.
        const parentRunId =
          (yield* runSession.readView([])).runs.get(resume.runId)?.parentId ??
          undefined;
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
          modelHandlerCompatibilityKey: resume.modelHandlerCompatibilityKey,
          session: runSession,
          toolPolicy: {
            approvalPromptsUnavailable: options.approvalPromptsUnavailable,
            runtimeUnavailableTools: options.runtimeUnavailableTools,
          },
        });
        return { ctx, parentRunId };
      }),
    );
    if (Exit.isFailure(setup)) {
      return yield* Effect.failCause(setup.cause).pipe(
        Effect.onExit(() => runSession.releaseRunLease(resume.runId)),
      );
    }
    const { ctx, parentRunId } = setup.value;
    const { setting } = ctx;
    const result = yield* Effect.exit(
      Effect.suspend(() =>
        withLaunchRunContext(
          ctx,
          { onApprovalPolicyDenial: options.onApprovalPolicyDenial },
          () => {
            const runInScope = AsyncLocalStorage.bind(<A>(operation: () => A) =>
              operation(),
            );
            return runFlowWithLifecycle(
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
                      { ...options, setting, parentRunId, toolInjections },
                      {
                        kind: 'resume',
                        resume,
                        drainedFollowUps: options.drainedFollowUps,
                        takePendingFollowUps: options.takePendingFollowUps,
                        isCancellationRequested:
                          options.isCancellationRequested,
                        onCancellationAtFlowAttachment:
                          options.onCancellationAtFlowAttachment,
                      },
                      runInScope,
                    ),
              buildLifecycleOptions(options, parentRunId),
            );
          },
        ),
      ),
    );
    if (Exit.isFailure(result)) {
      const released = yield* Effect.exit(
        runSession.releaseRunLease(resume.runId),
      );
      if (Exit.isFailure(released)) {
        return yield* Effect.fail(
          new AggregateError(
            [Cause.squash(result.cause), Cause.squash(released.cause)],
            `Run ${resume.runId} failed and its final artifacts could not be persisted`,
          ),
        );
      }
      return yield* Effect.failCause(result.cause);
    }
    // A WAITING result retains ownership for the next resumed turn.
    if (!isWaitingFlowResult(result.value)) {
      yield* runSession.releaseRunLease(resume.runId);
    }
    return result.value;
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
  resume: ToolUseResumeData,
  options: ResumeToolUseFromResumeDataOptions & { session: SessionHandle },
) {
  const session = options.session;
  const rollback = yield* acquireResumedRunOwnership(session, resume.runId);
  const retrieval = yield* Effect.exit(
    retrieveSessionResumeData(resume.runId, resume.agentConfig, session).pipe(
      Effect.flatMap((retrieved) =>
        retrieved?.type === 'toolUse'
          ? Effect.succeed(retrieved)
          : Effect.fail(new ResumeSessionUnavailableError(resume.runId)),
      ),
    ),
  );
  if (Exit.isFailure(retrieval)) {
    const released = yield* Effect.exit(rollback);
    return yield* Effect.fail(
      Exit.isFailure(released)
        ? new AggregateError(
            [Cause.squash(retrieval.cause), Cause.squash(released.cause)],
            `Resume retrieval and admission rollback failed for ${resume.runId}`,
          )
        : ensureError(Cause.squash(retrieval.cause)),
    );
  }
  // The launched turn owns release from here, including setup failures.
  return yield* resumeToolUseWithOwnedLease(retrieval.value, options);
}, Effect.uninterruptible);

/** Resume after the previous generation and its teardown have settled. */
export function resumeToolUseFromResumeData(
  resume: ToolUseResumeData,
  options: ResumeToolUseFromResumeDataOptions & { session: SessionHandle },
): Effect.Effect<AgentRuntimeFlowResult, Error, AgentRunServices> {
  return options.session.runs.launchRun(
    resume.runId,
    resumeToolUseTurn(resume, options),
  );
}

// Close the delegation recursion: the delegation tools drive child runs
// through `nativeSubagentStrategy`, whose engine calls are provided here —
// the one direction that cannot be a static import, because this module's
// flow drivers statically import the tool registry that includes those tools.
provideAgentEngine({
  executeAgent,
  resumeToolUseTurn,
});
