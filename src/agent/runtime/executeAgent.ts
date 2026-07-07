import * as path from 'node:path';

import { logConversationProgress } from '@agent/trace';
import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import {
  getToolUseFlowErrorResult,
  runToolUseFlow,
  type RunToolUseFlowResult,
} from '@agent/implementations/flows/tooluse/runToolUseFlow';
import { emitRuntimeEvent } from '@agent/runtime/emitRuntimeEvent';
import type { IToolUseSession } from '@agent/core/flows/IToolUseSession';
import type { ToolUseBeforeWaitingCallback } from '@agent/implementations/flows/tooluse/ToolUseServices';
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
import { computeDelegationDepthFromStorage } from '@agent/runtime/delegationPolicy';
import type { ProgressEventPayloads } from '@agent/runtime/hostProgressEvents';
import { AgentError, getSdkErrorMessage } from '@common/errors';
import { createChannelTrace } from '@logger';
import {
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
import { runFlowWithLifecycle } from './AgentRunLifecycle';
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
import type { ToolEditApprovalPort } from '@platform/interfaces/toolEditApproval';
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
    emitRuntimeEvent('updateQueuedFollowUps', { streamId: ctx.streamId });
    onFollowUpConsumed?.();
  };
}

function assertAllowedWaitingResult(
  result: AgentRuntimeFlowResult,
  allowWaitingResult: boolean | undefined,
  callerName: string,
): void {
  if (isWaitingFlowResult(result) && allowWaitingResult !== true) {
    throw new Error(
      `${callerName} received a non-terminal WAITING result without allowWaitingResult.`,
    );
  }
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
  setting: AgentToolUseSetting,
  options: Pick<
    ExecuteAgentOptions,
    'isSubagent' | 'onBeforeWaiting' | 'onFollowUpConsumed' | 'onProgress'
  >,
): Promise<AgentRuntimeFlowResult> {
  const { streamId } = ctx;
  const onRoundFinalized = createUsageRecordingCallback(ctx);
  try {
    const result = await runToolUseFlow(
      {
        ...ctx,
        ...createInterruptCallbacks(),
        onRoundFinalized,
        setting,
        isSubagent: options.isSubagent,
        onBeforeWaiting: options.onBeforeWaiting,
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
      ctx.executionId,
      streamId,
      ctx.attachedMemoryMisses,
    );
  } catch (err) {
    const failedResult = getToolUseFlowErrorResult(err);
    if (!failedResult) throw err;
    const result = buildToolUseFlowResult(
      failedResult,
      ctx.executionId,
      streamId,
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
  setting: AgentWorkflowSetting,
): Promise<AgentFlowResult> {
  const { streamId } = ctx;
  const onRoundFinalized = createUsageRecordingCallback(ctx);
  const result = await runReflectionFlow({
    ...ctx,
    ...createInterruptCallbacks(),
    onRoundFinalized,
    setting,
  });
  return buildWorkflowFlowResult(
    result,
    ctx.executionId,
    streamId,
    ctx.attachedMemoryMisses,
  );
}

/** Toast payload shown when the progress view cannot be opened. */
type FallbackNotification = NonNullable<
  ProgressEventPayloads['requestEnsureProgressView']['fallbackNotification']
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

/** Options for executeAgent. */
export interface ExecuteAgentOptions {
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
  /** Parent stream ID for subagent lineage tracking. Defaults to own streamId. */
  parentStreamId?: StreamTabId;
  /**
   * Depth of this execution in the delegation chain. Root (user-initiated) is 0;
   * each delegate_agent / delegate_workflow call increments it. Used to gate
   * nested delegation based on the Multi-Agent settings. Defaults to 0.
   */
  delegationDepth?: number;
  /** Fires with the real streamId before the stream is activated (before UI sync). */
  onStreamResolved?: (streamId: StreamTabId) => void;
  /** Fires before a tool-use subagent enters WAITING, delivering interim result to orchestrator. */
  onBeforeWaiting?: ToolUseBeforeWaitingCallback;
  /** Fires when a tool-use session consumes queued follow-up instructions. */
  onFollowUpConsumed?: () => void;
  /** Fires on meaningful progress: todo changes and tool call milestones. */
  onProgress?: (update: SubagentProgressUpdate) => void;
  /** Stop a tool-use execution after one model/tool cycle instead of waiting for follow-up input. */
  stopAfterCycle?: boolean;
  /**
   * Allow the promise to resolve with the non-terminal WAITING result. This is
   * reserved for native subagent drivers that keep the execution handle and
   * delivery state alive across conversational turns.
   */
  allowWaitingResult?: boolean;
  /** Hide tools whose approval prompts cannot be answered in this host mode. */
  approvalPromptsUnavailable?: boolean;
  /** Hide tools unavailable because the current host/runtime cannot support them. */
  runtimeUnavailableTools?: readonly string[];
  /** Session owning this run's coordination state. Defaults to the process session. */
  session?: SessionHandle;
  /**
   * Per-run override for the host's tool-edit approval UI. Hosts that manage
   * more than one concurrent session per process (e.g. desktop, one window per
   * run) pass their session-scoped handler here instead of relying on the
   * frozen, process-wide `platform().toolEditApproval` port.
   */
  toolEditApprovalHandler?: ToolEditApprovalPort;
  /** Resume using this persisted provider-message format instead of today's default route. */
  modelHandlerCompatibilityKey?: ModelHandlerCompatibilityKey | null;
  /** Fires after flow completes but before SharedExecutionRegistry.untrack, so follow-ups are enqueued before waiters resolve. */
  onCompleted?: (result: AgentFlowResult) => void | Promise<void>;
  /** Fires when a subagent fails and should report the failure to its orchestrator. */
  onError?: (error: unknown, result: AgentFlowResult) => void | Promise<void>;
  /** Fires once with the live per-run handle right after it is tracked (F-2). */
  onRun?: (handle: AgentRunHandle) => void | Promise<void>;
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
  const ctx = await buildAgentLaunchContext({
    configPayload,
    executionId,
    runtimeHost,
    onBeforeActivation: options.onStreamResolved,
    enforceCategory: options.enforceCategory,
    suppressErrorNotification: options.isSubagent,
    session: options.session,
    modelHandlerCompatibilityKey: options.modelHandlerCompatibilityKey,
  });
  ctx.delegation = {
    delegationDepth: options.delegationDepth ?? 0,
    approvalPromptsUnavailable: options.approvalPromptsUnavailable,
  };
  ctx.runtimeUnavailableTools = options.runtimeUnavailableTools;
  ctx.stopAfterCycle = options.stopAfterCycle;
  ctx.toolEditApprovalHandler = options.toolEditApprovalHandler;
  return withExecutionRunContext(ctx, async () => {
    const { setting, streamId, config } = ctx;
    const { isSubagent } = options;

    // Fire-and-forget: generate AI session description from the user's instruction.
    // Triggered at the start so cancelled/errored sessions still get descriptions.
    // Applies to tool-use agents, including subagents, so their progress tabs show
    // meaningful descriptions in multi-agent pipelines.
    generateSessionDescription(
      ctx.executionId,
      streamId,
      config,
      ctx.runtimeHost,
    ).catch(() => {});
    const result = await runFlowWithLifecycle(
      ctx,
      async (handle) => {
        // Pre-execution UI setup (RUNNING is set by runFlowWithLifecycle)
        if (executionId) await ensureRunDir(executionId);
        logger.info(`Starting task execution (streamId: ${streamId})`);
        logger.info(`Input file: ${config.inputFiles[0] ?? '(none)'}`);
        logger.debug('Task execution details', {
          data: { streamId, agent: config.agent, model: config.model },
        });
        logger.debug(`Output files: ${config.outputFiles?.length ?? 0}`);
        // Subagents don't need to force-open the progress board or show notifications —
        // the orchestrator's stream is already visible.
        if (!isSubagent && !getProgressViewBridge().isViewVisible()) {
          ctx.runtimeHost.emit('requestEnsureProgressView', {
            fallbackNotification: buildFallbackNotification(config),
          });
        }
        logger.info('Executing agent', {
          data: { agent: config.agent, model: config.model },
        });

        if (setting.agentCategory === AgentCategory.ToolUse) {
          return runToolUseAgent(ctx, handle, setting, options);
        }
        return runReflectionAgent(ctx, setting);
      },
      {
        isSubagent,
        parentStreamId: options.parentStreamId,
        onCompleted: options.onCompleted,
        onError: options.onError,
        onRun: options.onRun,
      },
    );
    assertAllowedWaitingResult(
      result,
      options.allowWaitingResult,
      'executeAgent',
    );
    return result;
  });
}

export interface ResumeToolUseFromSnapshotOptions {
  /** Hide tools whose approval prompts cannot be answered in this host mode. */
  readonly approvalPromptsUnavailable?: boolean;
  /** Hide tools unavailable because the current host/runtime cannot support them. */
  readonly runtimeUnavailableTools?: readonly string[];
  /** Session owning this run's coordination state. Defaults to the process session. */
  readonly session?: SessionHandle;
  /** Per-run override for the host's tool-edit approval UI — see `ExecuteAgentOptions.toolEditApprovalHandler`. */
  readonly toolEditApprovalHandler?: ToolEditApprovalPort;
  readonly onRun?: (handle: AgentRunHandle) => void | Promise<void>;
  readonly onBeforeWaiting?: ToolUseBeforeWaitingCallback;
  readonly onFollowUpConsumed?: () => void;
  readonly onProgress?: (update: SubagentProgressUpdate) => void;
  readonly onCompleted?: (result: AgentFlowResult) => void | Promise<void>;
  readonly onError?: (
    error: unknown,
    result: AgentFlowResult,
  ) => void | Promise<void>;
  readonly parentStreamId?: StreamTabId;
  readonly allowWaitingResult?: boolean;
  readonly setupSession?: (session: IToolUseSession) => void;
}

export async function resumeToolUseFromSnapshot(
  snapshot: ToolUseSessionSnapshot,
  runtimeHost: AgentRuntimeHost,
  options: ResumeToolUseFromSnapshotOptions = {},
): Promise<AgentRuntimeFlowResult> {
  const modelHandlerCompatibilityKey =
    snapshot.modelHandlerCompatibilityKey ??
    inferPersistedModelHandlerCompatibilityKey(
      snapshot.agentConfig.model,
      snapshot.messages,
    );
  const ctx = await buildAgentLaunchContext({
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
  // Recover delegation depth from the persisted parent-execution chain
  // so resumed subagents remain gated by the nested-delegation policy
  // instead of silently promoting to root.
  ctx.delegation = {
    delegationDepth: await computeDelegationDepthFromStorage(
      snapshot.executionId,
    ),
    approvalPromptsUnavailable: options.approvalPromptsUnavailable,
  };
  ctx.runtimeUnavailableTools = options.runtimeUnavailableTools;
  ctx.toolEditApprovalHandler = options.toolEditApprovalHandler;
  const { setting, streamId } = ctx;

  return withExecutionRunContext(ctx, async () => {
    if (setting.agentCategory !== AgentCategory.ToolUse) {
      throw new AgentError(
        'Attempted to resume a non tool-use agent with resumeToolUseFromSnapshot.',
      );
    }

    const isSubagent = (ctx.delegation?.delegationDepth ?? 0) > 0;
    const result = await runFlowWithLifecycle(
      ctx,
      async (handle) => {
        const result = await runToolUseFlow(
          {
            ...ctx,
            ...createInterruptCallbacks(),
            onRoundFinalized: createUsageRecordingCallback(ctx),
            setting,
            resumeSnapshot: snapshot,
            // Derive from the recovered parent chain: any execution with a
            // parent is a subagent. Without this, the rebuilt system prompt
            // would drop subagent-specific instructions (e.g. the shared
            // /memories protocol) that the fresh run had included.
            isSubagent,
            onBeforeWaiting: options.onBeforeWaiting,
            onProgress: options.onProgress,
            onFollowUpConsumed: wrapOnFollowUpConsumed(
              ctx,
              options.onFollowUpConsumed,
            ),
          },
          undefined,
          (flowContext) => {
            handle.attachToolUseFlow(flowContext);
            options.setupSession?.(flowContext.session);
            return () => handle.detachToolUseFlow(flowContext);
          },
        );
        return buildToolUseFlowResult(
          result,
          ctx.executionId,
          streamId,
          ctx.attachedMemoryMisses,
        );
      },
      {
        isSubagent,
        parentStreamId: options.parentStreamId,
        onCompleted: options.onCompleted,
        onError: options.onError,
        onRun: options.onRun,
      },
    );
    assertAllowedWaitingResult(
      result,
      options.allowWaitingResult,
      'resumeToolUseFromSnapshot',
    );
    return result;
  });
}
