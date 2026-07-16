import * as path from 'node:path';

import { logConversationProgress } from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import {
  getToolUseFlowErrorResult,
  runToolUseFlow,
  type RunToolUseFlowResult,
} from '@agent/implementations/flows/tooluse/runToolUseFlow';
import type { FollowUpQueueBatchItem } from '@agent/followUp/FollowUpQueue';
import {
  runReflectionFlow,
  type RunReflectionFlowResult,
} from '@agent/implementations/flows/reflection/runReflectionFlow';
import { inferPersistedModelHandlerCompatibilityKey } from '@agent/runtime/modelHandlerCompatibilityInference';
import {
  type AgentConfig,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import type { RoundFinalizedCallback } from '@agent/core/flows/BaseFlowServices';
import {
  AgentCategory,
  type AgentToolUseSetting,
  type AgentWorkflowSetting,
} from '@agent/core/definition/AgentDataclass';
import { hasPersistedParent } from '@agent/storage/executionLifecycle';
import {
  acquireResumedExecutionLease,
  releaseOwnedExecutionLease,
} from '@agent/storage/executionLease';
import { AgentError, getSdkErrorMessage } from '@common/errors';
import {
  type RequestEnsureProgressViewPayload,
  type StreamTabId,
  type ExecutionId,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import {
  roundOutputsToCompileFailureSummaries,
  roundOutputsToOutputSummaries,
} from '@shared/schemas/output';
import { ensureRunDir } from '@utils/files/taskRunStorage';

import {
  buildAgentLaunchContext,
  withExecutionRunContext,
  type AgentLaunchContext,
} from './AgentLaunchContext';
import {
  runFlowWithLifecycle,
  type FlowLifecycleControl,
} from './AgentRunLifecycle';
import {
  AgentFlowError,
  buildOptionalFlowResultFields,
  isWaitingFlowResult,
  type AgentRuntimeFlowResult,
  type WaitingToolUseFlowResult,
  type AgentFlowResult,
} from './AgentFlowResult';
import { createInterruptCallbacks } from './InterruptManager';
import { generateSessionDescription } from './sessionDescription';
import { getProgressViewBridge } from './ProgressViewBridge';
import type { SessionHandle } from './SessionHandle';
import type { AgentExecutionHandle, AgentRunHandle } from './executionRegistry';
import type { AgentRuntimeHost } from './AgentRuntimeHost';
import type { ModelHandlerCompatibilityKey } from './modelHandlerCompatibilityKey';

const CHANNEL = 'executeAgent';
const logger = createChannelTrace(CHANNEL);

/** Build a workflow AgentFlowResult from a reflection flow run. */
function buildWorkflowFlowResult(
  result: RunReflectionFlowResult,
  executionId: ExecutionId,
  streamId: StreamTabId,
  memoryMisses: AgentFlowResult['memoryMisses'],
): AgentFlowResult {
  return {
    category: 'workflow',
    outcome: result.outcome,
    outputs: roundOutputsToOutputSummaries(result.roundOutputs),
    compileFailures: roundOutputsToCompileFailureSummaries(result.roundOutputs),
    executionId,
    streamId,
    ...buildOptionalFlowResultFields(memoryMisses, result.totalCostUsd),
  };
}

/** Build a tool-use AgentFlowResult from a tool-use flow run. */
function buildToolUseFlowResult(
  result: RunToolUseFlowResult,
  executionId: ExecutionId,
  streamId: StreamTabId,
  memoryMisses: AgentFlowResult['memoryMisses'],
): AgentRuntimeFlowResult {
  return {
    category: 'toolUse',
    outcome: result.outcome,
    lastResponse: result.lastResponse,
    touchedFiles: result.touchedFiles,
    executionId,
    streamId,
    ...buildOptionalFlowResultFields(memoryMisses, result.totalCostUsd),
  };
}

/** Create the awaited round-finalized callback used by agent flows. */
function createUsageRecordingCallback(
  ctx: AgentLaunchContext,
): RoundFinalizedCallback {
  return async (run) => {
    await ctx.usageMonitor.recordUsage(run);
  };
}

function wrapOnFollowUpConsumed(
  ctx: AgentLaunchContext,
  onFollowUpConsumed?: () => void,
): () => void {
  return () => {
    const { streamId: runStreamId, session: runSession } = ctx.runScope;
    runSession.events.emit({
      scope: 'session',
      event: {
        type: 'updateQueuedFollowUps',
        payload: { streamId: runStreamId },
      },
    });
    onFollowUpConsumed?.();
  };
}

/**
 * Run the tool-use flow for a single agent execution.
 *
 * Owns all tool-use-specific wiring: progress counters, follow-up queuing,
 * model-change side effects, and error wrapping into `AgentFlowError`.
 * The caller (`executeAgent`) owns lifecycle and stream-status; this function
 * owns only what is specific to the ToolUse category.
 */
async function runToolUseAgent(
  ctx: AgentLaunchContext,
  handle: AgentExecutionHandle,
  lifecycle: FlowLifecycleControl,
  setting: AgentToolUseSetting,
  options: Pick<
    ExecuteAgentOptions,
    'isSubagent' | 'onFollowUpConsumed' | 'onProgress' | 'onIdle'
  >,
): Promise<AgentRuntimeFlowResult> {
  const {
    streamId: runStreamId,
    executionId: runExecutionId,
    session: runSession,
  } = ctx.runScope;
  const onRoundFinalized = createUsageRecordingCallback(ctx);
  try {
    const result = await runToolUseFlow(
      {
        ...ctx,
        streamStatus: runSession.status,
        ...createInterruptCallbacks(),
        onRoundFinalized,
        setting,
        isSubagent: options.isSubagent,
        onIdle: options.onIdle,
        onProgress: (update) => {
          if (update.kind === 'overview') {
            logConversationProgress(ctx.logger, {
              toolCallCount: update.toolCallCount,
            });
          }
          options.onProgress?.(update);
        },
        onFollowUpConsumed: wrapOnFollowUpConsumed(
          ctx,
          options.onFollowUpConsumed,
        ),
        onFlowRecordDisposition: (disposition) =>
          lifecycle.setFlowRecordDisposition(disposition),
        onModelChanged: (modelHandler) => {
          // The tool-use flow already wrote services.config.model
          // (=== ctx.config.model, same object), so the live model is updated
          // before this fires; only the usage side-effect is left to do here.
          ctx.usageMonitor.setModelInfo({
            capabilities: modelHandler.capabilities,
            config: modelHandler.config,
          });
        },
      },
      undefined,
      (flowContext) => {
        handle.attachToolUseFlow(flowContext);
        return () => handle.detachToolUseFlow(flowContext);
      },
    );
    return buildToolUseFlowResult(
      result,
      runExecutionId,
      runStreamId,
      ctx.attachedMemoryMisses,
    );
  } catch (err) {
    const failedResult = getToolUseFlowErrorResult(err);
    if (!failedResult) throw err;
    const result = buildToolUseFlowResult(
      failedResult,
      runExecutionId,
      runStreamId,
      ctx.attachedMemoryMisses,
    );
    if (isWaitingFlowResult(result)) throw err;
    throw new AgentFlowError(getSdkErrorMessage(err), result, { cause: err });
  }
}

/**
 * Run the reflection (workflow) flow for a single agent execution.
 *
 * Owns workflow-specific usage recording. The caller (`executeAgent`) owns
 * lifecycle and stream-status.
 */
async function runReflectionAgent(
  ctx: AgentLaunchContext,
  handle: AgentExecutionHandle,
  setting: AgentWorkflowSetting,
): Promise<AgentFlowResult> {
  const {
    streamId: runStreamId,
    executionId: runExecutionId,
    session: runSession,
  } = ctx.runScope;
  const onRoundFinalized = createUsageRecordingCallback(ctx);
  const interruptCallbacks = createInterruptCallbacks();
  const detachInterruptHandler = handle.attachInterruptHandler({
    interrupt(): void {
      interruptCallbacks.onInterrupt?.();
      runSession.interactions.cancel({
        streamId: runStreamId,
        cause: 'Run interrupted.',
      });
    },
  });
  let result: Awaited<ReturnType<typeof runReflectionFlow>>;
  try {
    result = await runReflectionFlow({
      ...ctx,
      streamStatus: runSession.status,
      ...interruptCallbacks,
      onRoundFinalized,
      setting,
    });
  } finally {
    detachInterruptHandler();
  }
  return buildWorkflowFlowResult(
    result,
    runExecutionId,
    runStreamId,
    ctx.attachedMemoryMisses,
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
 * subagent run (`executeAgent`, `resumeToolUseFromSnapshot`, and
 * `resumeQueuedToolUseSnapshot`). Extracted so the three option bags describing
 * the same run can't silently drift out of sync or re-declare the same field
 * under a different name.
 */
export interface SubagentRunOptions {
  /** Parent stream ID for subagent lineage tracking. Defaults to own streamId. */
  parentStreamId?: StreamTabId;
  /** Fires when a tool-use session consumes queued follow-up instructions. */
  onFollowUpConsumed?: () => void;
  /** Fires on meaningful progress: todo changes and tool call milestones. */
  onProgress?: (update: SubagentProgressUpdate) => void;
  /** Hide tools whose approval prompts cannot be answered in this host mode. */
  approvalPromptsUnavailable?: boolean;
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
}

/** Options for executeAgent. */
export interface ExecuteAgentOptions extends SubagentRunOptions {
  /** Host services used by the runtime to report progress/UI events. */
  runtimeHost: AgentRuntimeHost;
  /** When true, proposal tools are filtered out to prevent nesting. */
  isSubagent?: boolean;
  /**
   * When true, enforce that configPayload.agentCategory matches the agent's
   * YAML-defined category. Callers that explicitly set a category (e.g.
   * DelegationTools) should opt in; callers that pass pre-parsed configs with
   * prefaulted defaults (e.g. runExecuteCommand) should leave this off.
   */
  enforceCategory?: boolean;
  /** Fires with the real streamId before the stream is activated (before UI sync). */
  onStreamResolved?: (streamId: StreamTabId) => void;
  /** Root-run-only: fires with the latest response at every cycle boundary — see `ToolUseServices.onIdle`. */
  onIdle?: (lastResponse: string | undefined) => void;
  /** Stop a tool-use execution after one model/tool cycle instead of waiting for follow-up input. */
  stopAfterCycle?: boolean;
  /**
   * Allow the promise to resolve with the non-terminal WAITING result. Only
   * a fresh launch of a persistent native subagent (`isSubagent` without
   * `stopAfterCycle`) can produce one, so only such drivers opt in. Resume
   * paths have no equivalent flag: whether a resumed run is a subagent comes
   * from persisted lineage, so `resumeToolUseFromSnapshot` always admits
   * WAITING and callers narrow with `isWaitingFlowResult`.
   */
  allowWaitingResult?: boolean;
  /** Resume using this persisted provider-message format instead of today's default route. */
  modelHandlerCompatibilityKey?: ModelHandlerCompatibilityKey | null;
}

export function executeAgent(
  configPayload: AgentConfigPayload,
  executionId: ExecutionId | undefined,
  options: ExecuteAgentOptions & { allowWaitingResult: true },
): Promise<AgentFlowResult | WaitingToolUseFlowResult>;
export function executeAgent(
  configPayload: AgentConfigPayload,
  executionId: ExecutionId | undefined,
  options: ExecuteAgentOptions & { allowWaitingResult?: false | undefined },
): Promise<AgentFlowResult>;

/**
 * Low-level execution runner for an already-registered execution. Fresh
 * launches should use `runAgent()` or call `registerExecution()` first so the
 * canonical `executions/{id}/config.json` exists before `run.start` exposes
 * its descriptor. Resume paths reuse the existing execution record.
 */
export async function executeAgent(
  configPayload: AgentConfigPayload,
  executionId: ExecutionId | undefined,
  options: ExecuteAgentOptions,
): Promise<AgentRuntimeFlowResult> {
  if (options == null || options.runtimeHost == null) {
    throw new Error('executeAgent requires an explicit runtimeHost');
  }

  const { runtimeHost } = options;
  let ctx: AgentLaunchContext;
  try {
    ctx = await buildAgentLaunchContext({
      configPayload,
      executionId,
      runtimeHost,
      onBeforeActivation: options.onStreamResolved,
      enforceCategory: options.enforceCategory,
      suppressErrorNotification: options.isSubagent,
      session: options.session,
      modelHandlerCompatibilityKey: options.modelHandlerCompatibilityKey,
    });
  } catch (error) {
    if (executionId) await releaseOwnedExecutionLease(executionId);
    throw error;
  }
  const runContextOptions = {
    approvalPromptsUnavailable: options.approvalPromptsUnavailable,
    runtimeUnavailableTools: options.runtimeUnavailableTools,
    stopAfterCycle: options.stopAfterCycle,
  };
  try {
    return await withExecutionRunContext(ctx, runContextOptions, async () => {
      const { setting, config } = ctx;
      const {
        streamId: runStreamId,
        executionId: runExecutionId,
        session: runSession,
        runtimeHost: runRuntimeHost,
      } = ctx.runScope;
      const { isSubagent } = options;

      // Fire-and-forget: generate AI session description from the user's instruction.
      // Triggered at the start so cancelled/errored sessions still get descriptions.
      // Applies to tool-use agents, including subagents, so their progress tabs show
      // meaningful descriptions in multi-agent pipelines. The callee owns its
      // best-effort failure reporting and never rejects.
      void generateSessionDescription(
        runExecutionId,
        runStreamId,
        config,
        runSession,
      );
      const result = await runFlowWithLifecycle(
        ctx,
        async (handle, lifecycle) => {
          // Pre-execution UI setup (RUNNING is set by runFlowWithLifecycle)
          if (executionId) await ensureRunDir(executionId);
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
          if (!isSubagent && !getProgressViewBridge().isViewVisible()) {
            runRuntimeHost.emit('requestEnsureProgressView', {
              fallbackNotification: buildFallbackNotification(config),
            });
          }
          logger.info('Executing agent', {
            data: { agent: config.agent, model: config.model },
          });

          if (setting.agentCategory === AgentCategory.ToolUse) {
            return runToolUseAgent(ctx, handle, lifecycle, setting, options);
          }
          return runReflectionAgent(ctx, handle, setting);
        },
        {
          isSubagent,
          parentStreamId: options.parentStreamId,
          onError: options.onRunError,
          onRun: options.onRun,
        },
      );
      if (isWaitingFlowResult(result) && options.allowWaitingResult !== true) {
        throw new Error(
          'executeAgent received a non-terminal WAITING result without allowWaitingResult.',
        );
      }
      return result;
    });
  } catch (error) {
    if (executionId) await releaseOwnedExecutionLease(executionId);
    throw error;
  }
}

export interface ResumeToolUseFromSnapshotOptions extends SubagentRunOptions {
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
export async function resumeToolUseFromSnapshot(
  snapshot: ToolUseSessionSnapshot,
  runtimeHost: AgentRuntimeHost,
  options: ResumeToolUseFromSnapshotOptions = {},
): Promise<AgentRuntimeFlowResult> {
  const leaseAcquisition = await acquireResumedExecutionLease(
    snapshot.executionId,
  );
  const modelHandlerCompatibilityKey =
    snapshot.modelHandlerCompatibilityKey ??
    inferPersistedModelHandlerCompatibilityKey(
      snapshot.agentConfig.model,
      snapshot.messages,
    );
  // Resolve persisted lineage before launch assembly activates the stream and
  // transfers its resources. Storage failures must propagate without leaving
  // an activated resume stream outside lifecycle cleanup.
  let isSubagent: boolean;
  let ctx: AgentLaunchContext;
  try {
    isSubagent = await hasPersistedParent(snapshot.executionId);
    ctx = await buildAgentLaunchContext({
      configPayload: snapshot.agentConfig,
      executionId: snapshot.executionId,
      runtimeHost,
      streamTabIdOverride: snapshot.streamId,
      modelHandlerCompatibilityKey,
      // resumeCommand surfaces its own warning toast on failure; skip the
      // bus-level error to avoid double-notifying.
      suppressErrorNotification: true,
      session: options.session,
    });
  } catch (error) {
    if (leaseAcquisition === 'acquired') {
      await releaseOwnedExecutionLease(snapshot.executionId);
    }
    throw error;
  }
  const runContextOptions = {
    approvalPromptsUnavailable: options.approvalPromptsUnavailable,
    runtimeUnavailableTools: options.runtimeUnavailableTools,
  };
  const { setting } = ctx;
  const {
    streamId: runStreamId,
    executionId: runExecutionId,
    session: runSession,
  } = ctx.runScope;

  try {
    return await withExecutionRunContext(ctx, runContextOptions, async () => {
      if (setting.agentCategory !== AgentCategory.ToolUse) {
        throw new AgentError(
          'Attempted to resume a non tool-use agent with resumeToolUseFromSnapshot.',
        );
      }

      const result = await runFlowWithLifecycle(
        ctx,
        async (handle, lifecycle) => {
          const result = await runToolUseFlow(
            {
              ...ctx,
              streamStatus: runSession.status,
              ...createInterruptCallbacks(),
              onRoundFinalized: createUsageRecordingCallback(ctx),
              setting,
              resumeSnapshot: snapshot,
              drainedFollowUps: options.drainedFollowUps,
              takePendingFollowUps: options.takePendingFollowUps,
              // A persisted parent marks this execution as a subagent. Without
              // this, the rebuilt system prompt would drop subagent-specific
              // instructions (e.g. the shared /memories protocol) that the fresh
              // run had included.
              isSubagent,
              onProgress: options.onProgress,
              onFollowUpConsumed: wrapOnFollowUpConsumed(
                ctx,
                options.onFollowUpConsumed,
              ),
              onFlowRecordDisposition: (disposition) =>
                lifecycle.setFlowRecordDisposition(disposition),
            },
            undefined,
            (flowContext) => {
              handle.attachToolUseFlow(flowContext);
              if (options.isCancellationRequested?.()) {
                options.onCancellationAtFlowAttachment?.();
                flowContext.interrupt();
              }
              return () => handle.detachToolUseFlow(flowContext);
            },
          );
          return buildToolUseFlowResult(
            result,
            runExecutionId,
            runStreamId,
            ctx.attachedMemoryMisses,
          );
        },
        {
          isSubagent,
          parentStreamId: options.parentStreamId,
          onError: options.onRunError,
          onRun: options.onRun,
        },
      );
      return result;
    });
  } catch (error) {
    if (leaseAcquisition === 'acquired') {
      await releaseOwnedExecutionLease(snapshot.executionId);
    }
    throw error;
  }
}
