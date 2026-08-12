import * as path from 'node:path';

import { logConversationProgress } from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
import { runToolUseFlow } from '@agent/implementations/flows/tooluse/runToolUseFlow';
import type { FollowUpQueueBatchItem } from '@agent/followUp/FollowUpQueue';
import { runReflectionFlow } from '@agent/implementations/flows/reflection/runReflectionFlow';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { RoundFinalizedCallback } from '@agent/core/flows/BaseFlowServices';
import {
  type AgentToolUseSetting,
  type AgentWorkflowSetting,
} from '@agent/core/definition/AgentDataclass';
import type { ITool } from '@agent/core/tools/ToolTypes';
import {
  clearTerminalExecutionState,
  getPersistedUserFollowUpSupport,
  hasPersistedParent,
} from '@agent/storage/executionLifecycle';
import {
  acquireResumedExecutionLease,
  captureOwnedExecutionLease,
  releaseOwnedExecutionLeaseAfterFailure,
} from '@agent/storage/executionLease';
import { AgentError } from '@common/errors';
import type { CopilotRouteOverride } from '@model/copilotRouting';
import {
  type RequestEnsureProgressViewPayload,
  type StreamTabId,
  type ExecutionId,
  type SubagentProgressUpdate,
  type UserFollowUpSupport,
  AgentCategory,
} from '@shared/schemas';
import {
  roundOutputsToCompileFailureSummaries,
  roundOutputsToOutputSummaries,
} from '@shared/schemas/output';
import { ensureRunDir } from '@utils/files/runStorageFs';

import {
  buildAgentLaunchContext,
  withExecutionRunContext,
  type AgentLaunchContext,
} from './AgentLaunchContext';
import {
  runFlowWithLifecycle,
  type FlowLifecycleControl,
  type RunFlowLifecycleOptions,
} from './AgentRunLifecycle';
import {
  buildOptionalFlowResultFields,
  isWaitingFlowResult,
  type AgentRuntimeFlowResult,
  type WaitingToolUseFlowResult,
  type AgentFlowResult,
} from './AgentFlowResult';
import { generateSessionDescription } from './sessionDescription';
import { releaseExecutionLeaseAfterArtifacts } from './executionOwnership';
import { ResumeAdmissionCancelledError } from './resumeAdmission';
import type { SessionHandle } from './SessionHandle';
import type { AgentExecutionHandle, AgentRunHandle } from './ExecutionHandle';
import type { ModelHandlerCompatibilityKey } from './modelHandlerCompatibilityKey';
import type { ToolUseResumeData } from './SessionResumeRetrieval';

const CHANNEL = 'executeAgent';
const logger = createChannelTrace(CHANNEL);

/** Create the awaited round-finalized callback used by agent flows. */
function createUsageRecordingCallback(
  ctx: AgentLaunchContext,
): RoundFinalizedCallback {
  return async (run) => {
    await ctx.usageMonitor.recordUsage(run);
  };
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
      readonly onIdle?: (lastResponse: string | undefined) => void;
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
 * Run the tool-use flow for a single agent execution, fresh or resumed.
 *
 * Owns all tool-use-specific wiring: progress counters, follow-up queuing, and
 * model-change side effects. A failed run arrives as a FAILED result carrying
 * its structured error, so there is nothing to unwrap here.
 * The callers (`executeAgent`, `resumeToolUseFromResumeData`) own lifecycle and
 * stream-status; this function owns only what is specific to the ToolUse
 * category.
 */
async function launchToolUseRun(
  ctx: AgentLaunchContext,
  handle: AgentExecutionHandle,
  lifecycle: FlowLifecycleControl,
  shared: SubagentRunOptions & {
    readonly setting: AgentToolUseSetting;
    /**
     * Fresh launches take this from the caller; resume derives it from
     * persisted lineage, because the rebuilt system prompt would otherwise drop
     * subagent-specific instructions (e.g. the shared /memories protocol) that
     * the fresh run had included.
     */
    readonly isSubagent?: boolean;
  },
  variant: ToolUseLaunchVariant,
): Promise<AgentRuntimeFlowResult> {
  const { streamId: runStreamId, executionId: runExecutionId } = ctx.runScope;
  const result = await runToolUseFlow(
    {
      ...ctx,
      onRoundFinalized: createUsageRecordingCallback(ctx),
      setting: shared.setting,
      isSubagent: shared.isSubagent,
      tools: shared.tools,
      onProgress: (update) => {
        if (update.kind === 'overview') {
          logConversationProgress(ctx.logger, {
            toolCallCount: update.toolCallCount,
          });
        }
        shared.onProgress?.(update);
      },
      onFollowUpConsumed: () => {
        ctx.runScope.session.events.emit({
          scope: 'session',
          event: {
            type: 'updateQueuedFollowUps',
            payload: { streamId: ctx.runScope.streamId },
          },
        });
        shared.onFollowUpConsumed?.();
      },
      onFlowRecordDisposition: (disposition) =>
        lifecycle.setFlowRecordDisposition(disposition),
      onModelChanged: (model) => {
        // The cell is the live model; usage accounting and the prompt-side
        // MODEL variable read it directly. This one mirror remains because
        // config.model is a persisted AgentConfig schema field, not a view
        // of the cell.
        ctx.config.model = model;
      },
      ...(variant.kind === 'fresh'
        ? { onIdle: variant.onIdle }
        : {
            resume: variant.resume,
            drainedFollowUps: variant.drainedFollowUps,
            takePendingFollowUps: variant.takePendingFollowUps,
          }),
    },
    undefined,
    {
      attach: (flowContext) => {
        handle.attachToolUseFlow(flowContext, ctx.runScope.signal);
        if (variant.kind === 'resume' && variant.isCancellationRequested?.()) {
          variant.onCancellationAtFlowAttachment?.();
          flowContext.interrupt();
        }
      },
      detach: (flowContext) => handle.detachToolUseFlow(flowContext),
    },
  );
  return {
    category: 'toolUse',
    outcome: result.outcome,
    response: result.response,
    files: result.files,
    executionId: runExecutionId,
    streamId: runStreamId,
    ...(result.structured !== undefined
      ? { structured: result.structured }
      : {}),
    ...(result.error ? { error: result.error } : {}),
    ...buildOptionalFlowResultFields(
      ctx.attachedMemoryMisses,
      result.totalCostUsd,
    ),
  };
}

/**
 * The lifecycle options every entry point that drives one run passes.
 * `isSubagent` stays a separate argument because resume derives it from
 * persisted lineage rather than from the caller's options.
 */
function buildLifecycleOptions(
  options: SubagentRunOptions,
  isSubagent: boolean | undefined,
): RunFlowLifecycleOptions {
  return {
    isSubagent,
    parentStreamId: options.parentStreamId,
    workflowPhase: options.workflowPhase,
    userFollowUpSupport: options.userFollowUpSupport,
    onError: options.onRunError,
    onRun: options.onRun,
  };
}

/**
 * Run the reflection (workflow) flow for a single agent execution.
 *
 * Owns workflow-specific usage recording. The caller (`executeAgent`) owns
 * lifecycle and stream-status.
 */
async function runReflectionAgent(
  ctx: AgentLaunchContext,
  setting: AgentWorkflowSetting,
): Promise<AgentFlowResult> {
  const { streamId: runStreamId, executionId: runExecutionId } = ctx.runScope;
  const result = await runReflectionFlow({
    ...ctx,
    onRoundFinalized: createUsageRecordingCallback(ctx),
    setting,
  });
  return {
    category: 'workflow',
    outcome: result.outcome,
    outputs: roundOutputsToOutputSummaries(result.roundOutputs),
    compileFailures: roundOutputsToCompileFailureSummaries(result.roundOutputs),
    executionId: runExecutionId,
    streamId: runStreamId,
    ...(result.error ? { error: result.error } : {}),
    ...buildOptionalFlowResultFields(
      ctx.attachedMemoryMisses,
      result.totalCostUsd,
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
  /** Parent stream ID for subagent lineage tracking. Defaults to own streamId. */
  parentStreamId?: StreamTabId;
  /** Fires when a tool-use session consumes queued follow-up instructions. */
  onFollowUpConsumed?: () => void;
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
   * Fires when the subagent run itself fails, so a caller can report the
   * failure up the delegation chain. Distinct from a host-level failure
   * surface such as `ResumeQueuedToolUseOptions.onError` (log + toast for a
   * failed resume-plumbing step) — this callback is about the run's outcome.
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
  /** Runtime behavior declared by the launch source, not UI visibility. */
  userFollowUpSupport?: UserFollowUpSupport;
}

/** Options for executeAgent. */
export interface ExecuteAgentOptions extends SubagentRunOptions {
  /** Cancel launch preparation before the per-run handle is available. */
  launchSignal?: AbortSignal;
  /** Registration-stamped stream identity for a resumed workflow launch. */
  streamTabIdOverride?: StreamTabId;
  /** The caller owns presentation for failures before the run lifecycle. */
  suppressErrorNotification?: boolean;
  /** When true, proposal tools are filtered out to prevent nesting. */
  isSubagent?: boolean;
  /**
   * When true, enforce that an explicitly supplied category matches the
   * agent's YAML-defined category.
   */
  enforceCategory?: boolean;
  /** Fires with the real streamId before the stream is activated (before UI sync). */
  onStreamResolved?: (streamId: StreamTabId) => void;
  /** Root-run-only: fires with the latest response at every cycle boundary — see `ToolUseServices.onIdle`. */
  onIdle?: (lastResponse: string | undefined) => void;
  /** Stop a tool-use execution after one model/tool cycle instead of waiting for follow-up input. */
  stopAfterCycle?: boolean;
  /**
   * Allow the promise to resolve with the non-terminal WAITING result.
   * `nativeSubagentStrategy` is the only caller that opts in: interactive
   * launches consume WAITING as a loop turn, while single-cycle launches admit
   * it so their durability wrapper can persist a meaningful invariant failure
   * rather than losing the returned turn and cost. The flag is inert for a
   * workflow-category flow (`isWaitingFlowResult` requires `category ===
   * 'toolUse'`). Resume paths have no equivalent flag: whether
   * a resumed run is a subagent comes from persisted lineage, so
   * `resumeToolUseFromResumeData` always admits WAITING and callers narrow
   * with `isWaitingFlowResult`.
   */
  allowWaitingResult?: boolean;
  /** Resume using this persisted provider-message format instead of today's default route. */
  modelHandlerCompatibilityKey?: ModelHandlerCompatibilityKey | null;
  /** Deliberate one-run bypass used only by a Copilot direct-key fallback. */
  copilotRouteOverride?: CopilotRouteOverride;
}

export function executeAgent(
  config: AgentConfig,
  executionId: ExecutionId,
  options: ExecuteAgentOptions & { allowWaitingResult: true },
): Promise<AgentFlowResult | WaitingToolUseFlowResult>;
export function executeAgent(
  config: AgentConfig,
  executionId: ExecutionId,
  options: ExecuteAgentOptions & { allowWaitingResult?: false | undefined },
): Promise<AgentFlowResult>;

/**
 * Low-level execution runner for an already-registered execution. Fresh
 * launches should use `runAgent()` or call `registerExecution()` first so the
 * canonical `executions/{id}/config.json` exists before `run.start` exposes
 * its identity. Resume paths reuse the existing execution record.
 */
export async function executeAgent(
  config: AgentConfig,
  executionId: ExecutionId,
  options: ExecuteAgentOptions,
): Promise<AgentRuntimeFlowResult> {
  const runWithOwnership = captureOwnedExecutionLease(executionId);
  return await runWithOwnership(async () => {
    const ctx = await buildAgentLaunchContext({
      config,
      executionId,
      streamTabIdOverride: options.streamTabIdOverride,
      onBeforeActivation: options.onStreamResolved,
      suppressViewSwitch: options.isSubagent,
      enforceCategory: options.enforceCategory,
      suppressErrorNotification:
        options.suppressErrorNotification ?? options.isSubagent,
      session: options.session,
      modelHandlerCompatibilityKey: options.modelHandlerCompatibilityKey,
      copilotRouteOverride: options.copilotRouteOverride,
      signal: options.launchSignal,
    });
    const runContextOptions = {
      approvalPromptsUnavailable: options.approvalPromptsUnavailable,
      onApprovalPolicyDenial: options.onApprovalPolicyDenial,
      runtimeUnavailableTools: options.runtimeUnavailableTools,
      stopAfterCycle: options.stopAfterCycle,
    };
    return withExecutionRunContext(ctx, runContextOptions, async () => {
      const { setting, config } = ctx;
      const {
        streamId: runStreamId,
        executionId: runExecutionId,
        session: runSession,
      } = ctx.runScope;
      const { isSubagent } = options;

      // Start description generation concurrently with the run, but join it
      // before the owner can release its execution lease. This prevents the
      // metadata write from recreating an execution deleted by another host.
      const sessionDescription = generateSessionDescription(
        runExecutionId,
        runStreamId,
        config,
        runSession,
        ctx.runScope.signal,
      );
      try {
        const result = await runFlowWithLifecycle(
          ctx,
          async (handle, lifecycle) => {
            // Pre-execution UI setup (RUNNING is set by runFlowWithLifecycle)
            await ensureRunDir(executionId);
            logger.info(`Starting task execution (streamId: ${runStreamId})`);
            logger.info(`Input file: ${config.inputFiles[0] ?? '(none)'}`);
            logger.debug('Task execution details', {
              data: {
                streamId: runStreamId,
                agent: config.agent,
                model: config.model,
              },
            });
            logger.debug(`Output files: ${config.outputFiles?.length ?? 0}`);
            // Subagents don't need to force-open the progress board or show notifications —
            // the orchestrator's stream is already visible.
            if (!isSubagent) {
              runSession.interactions.emit(
                'requestEnsureProgressView',
                { fallbackNotification: buildFallbackNotification(config) },
                { replayWhenAttached: true },
              );
            }
            logger.info('Executing agent', {
              data: { agent: config.agent, model: config.model },
            });

            if (setting.agentCategory === AgentCategory.ToolUse) {
              return launchToolUseRun(
                ctx,
                handle,
                lifecycle,
                { ...options, setting, isSubagent },
                { kind: 'fresh', onIdle: options.onIdle },
              );
            }
            return runReflectionAgent(ctx, setting);
          },
          buildLifecycleOptions(options, isSubagent),
        );
        if (
          isWaitingFlowResult(result) &&
          options.allowWaitingResult !== true
        ) {
          throw new Error(
            'executeAgent received a non-terminal WAITING result without allowWaitingResult.',
          );
        }
        return result;
      } finally {
        await sessionDescription;
      }
    });
  });
}

export interface ResumeToolUseFromResumeDataOptions extends SubagentRunOptions {
  /** Recheck canonical admission atomically while acquiring the resumed lease. */
  readonly canAcquireResumeLease?: () => boolean | Promise<boolean>;
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
 * is a subagent — and can therefore legitimately resolve WAITING again — comes
 * from persisted lineage (`hasPersistedParent`), never from the caller.
 */
export async function resumeToolUseFromResumeData(
  resume: ToolUseResumeData,
  options: ResumeToolUseFromResumeDataOptions = {},
): Promise<AgentRuntimeFlowResult> {
  const lease = await acquireResumedExecutionLease(
    resume.executionId,
    options.canAcquireResumeLease,
  );
  if (lease === 'cancelled') {
    throw new ResumeAdmissionCancelledError(resume.executionId);
  }
  const runWithOwnership = captureOwnedExecutionLease(resume.executionId);
  return await runWithOwnership(async () => {
    // Resolve persisted lineage before launch assembly activates the stream and
    // transfers its resources. Storage failures must propagate without leaving
    // an activated resume stream outside lifecycle cleanup.
    let isSubagent: boolean;
    let userFollowUpSupport: UserFollowUpSupport;
    let ctx: AgentLaunchContext;
    try {
      // This execution is running again, so the terminal facts its previous
      // run left behind stop describing it here, before any turn of the
      // resumed run can write a result envelope for readers to project onto.
      await clearTerminalExecutionState(resume.executionId);
      [isSubagent, userFollowUpSupport] = await Promise.all([
        hasPersistedParent(resume.executionId),
        getPersistedUserFollowUpSupport(resume.executionId),
      ]);
      ctx = await buildAgentLaunchContext({
        config: resume.agentConfig,
        executionId: resume.executionId,
        streamTabIdOverride: resume.streamId,
        // SessionResumeRetrieval already resolved the persisted ?? inferred key
        // for this exact record; do not re-infer here.
        modelHandlerCompatibilityKey:
          resume.shared.modelHandlerCompatibilityKey,
        suppressViewSwitch: isSubagent,
        // resumeCommand surfaces its own warning toast on failure; skip the
        // bus-level error to avoid double-notifying.
        suppressErrorNotification: true,
        session: options.session,
      });
    } catch (error) {
      throw await releaseOwnedExecutionLeaseAfterFailure(
        resume.executionId,
        error,
      );
    }
    const runContextOptions = {
      approvalPromptsUnavailable: options.approvalPromptsUnavailable,
      onApprovalPolicyDenial: options.onApprovalPolicyDenial,
      runtimeUnavailableTools: options.runtimeUnavailableTools,
    };
    const { setting } = ctx;
    const { streamId: runStreamId, session: runSession } = ctx.runScope;

    // Only the run itself is guarded here. The release below is deliberately
    // outside: a release that fails must not be retried by the catch arm.
    let result: AgentRuntimeFlowResult;
    try {
      result = await withExecutionRunContext(
        ctx,
        runContextOptions,
        async () => {
          if (setting.agentCategory !== AgentCategory.ToolUse) {
            // Keep this historical diagnostic byte-for-byte for external monitors.
            throw new AgentError(
              'Attempted to resume a non tool-use agent with resumeToolUseFromSnapshot.',
            );
          }

          await runSession.transcripts.ensureLoaded(runStreamId);

          return await runFlowWithLifecycle(
            ctx,
            async (handle, lifecycle) =>
              launchToolUseRun(
                ctx,
                handle,
                lifecycle,
                { ...options, setting, isSubagent },
                {
                  kind: 'resume',
                  resume,
                  drainedFollowUps: options.drainedFollowUps,
                  takePendingFollowUps: options.takePendingFollowUps,
                  isCancellationRequested: options.isCancellationRequested,
                  onCancellationAtFlowAttachment:
                    options.onCancellationAtFlowAttachment,
                },
              ),
            buildLifecycleOptions(
              { ...options, userFollowUpSupport },
              isSubagent,
            ),
          );
        },
      );
    } catch (error) {
      // The run's own failure is the one the caller must see; a release failure
      // on top of it is additional information, not a replacement.
      try {
        await releaseExecutionLeaseAfterArtifacts(
          runSession,
          resume.executionId,
        );
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          `Execution ${resume.executionId} failed and its final artifacts could not be persisted`,
        );
      }
      throw error;
    }
    // A WAITING result keeps the lease: the next resume owns this execution.
    if (!isWaitingFlowResult(result)) {
      await releaseExecutionLeaseAfterArtifacts(runSession, resume.executionId);
    }
    return result;
  });
}
