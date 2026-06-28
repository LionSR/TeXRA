import * as path from 'node:path';

import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import {
  getToolUseFlowErrorResult,
  runToolUseFlow,
  type RunToolUseFlowResult,
} from '@agent/implementations/flows/tooluse/runToolUseFlow';
import type { IToolUseSession } from '@agent/core/flows/IToolUseSession';
import type { ToolUseBeforeWaitingCallback } from '@agent/implementations/flows/tooluse/ToolUseServices';
import {
  runReflectionFlow,
  type RunReflectionFlowResult,
} from '@agent/implementations/flows/reflection/runReflectionFlow';
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
import { AgentError, getSdkErrorMessage } from '@common/errors';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';
import { createChannelTrace } from '@logger';
import {
  type StreamTabId,
  type ExecutionId,
  type OutputFileInfo,
  type RoundOutput,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import type {
  CompileFailureSummary,
  OutputFileSummary,
} from '@shared/schemas/output';
import { ensureRunDir } from '@utils/files/taskRunStorage';

import {
  buildAgentLaunchContext,
  withExecutionRunContext,
  type AgentLaunchContext,
} from './AgentLaunchContext';
import { runFlowWithLifecycle } from './AgentRunLifecycle';
import { buildRuntimeTaskStateFromConfig } from './executionRequests';
import { currentSession, type SessionHandle } from './SessionHandle';
import { createInterruptCallbacks } from './InterruptManager';
import { generateSessionDescription } from './sessionDescription';
import { isRuntimeProgressViewVisible } from './progressViewCommands';
import { publishRuntimeQueuedFollowUps } from './queuedFollowUps';
import {
  AgentFlowError,
  buildOptionalFlowResultFields,
  type AgentFlowResult,
} from './AgentFlowResult';
import type { AgentExecutionHandle, AgentRunHandle } from './executionRegistry';

const CHANNEL = 'executeAgent';
const logger = createChannelTrace(CHANNEL);

/**
 * Project `RoundOutput[]` → `OutputFileSummary[]` for inclusion in `AgentFlowResult`.
 *
 * `relativePath` falls back to `absolutePath` for `external` locations that have
 * no relative path. `originalPath` prefers `lineage.diffBase` (the snapshot used
 * for latexdiff) over `lineage.original` (the workspace source).
 */
function toOutputSummaries(roundOutputs: RoundOutput[]): OutputFileSummary[] {
  return roundOutputs.flatMap((r) =>
    r.outputs.map((o: OutputFileInfo) => ({
      round: r.round,
      relativePath:
        'relativePath' in o.location
          ? o.location.relativePath
          : o.location.absolutePath,
      absolutePath: o.location.absolutePath,
      location: o.location.kind,
      originalPath:
        o.lineage?.diffBase?.absolutePath ??
        o.lineage?.original?.absolutePath ??
        null,
      added: o.diff?.added ?? null,
      removed: o.diff?.removed ?? null,
    })),
  );
}

/**
 * Project `RoundOutput[]` → `CompileFailureSummary[]` for inclusion in `AgentFlowResult`.
 *
 * `outputPath` is workspace-relative for workspace/runStorage files and absolute
 * for external files (which have no meaningful relative path). `logPath` is always
 * relative; `logAbsolutePath` is provided separately for direct file-open calls.
 */
function toCompileFailureSummaries(
  roundOutputs: RoundOutput[],
): CompileFailureSummary[] {
  return roundOutputs.flatMap((r) =>
    r.compileFailures.map((failure) => ({
      round: failure.round,
      displayName: failure.displayName,
      outputPath:
        failure.output.kind === 'external'
          ? failure.output.absolutePath
          : failure.output.relativePath,
      logPath: failure.logRelativePath,
      logAbsolutePath: failure.log.absolutePath,
    })),
  );
}

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
    outputs: toOutputSummaries(result.roundOutputs),
    compileFailures: toCompileFailureSummaries(result.roundOutputs),
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
): AgentFlowResult {
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

/** Create an onRoundCompleted callback that feeds progress into the execution registry and orchestrator. */
function createRoundProgressCallback(
  executionId: ExecutionId,
  streamId: StreamTabId,
  runtimeHost: AgentRuntimeHost,
  onProgress?: (update: SubagentProgressUpdate) => void,
): (
  roundIndex: number,
  totalRounds: number,
  outputPaths?: readonly string[],
) => void {
  return (roundIndex, totalRounds, outputPaths) => {
    currentSession().executions.updateProgress(executionId, {
      currentRound: roundIndex,
      totalRounds,
    });
    onProgress?.({
      kind: 'round',
      currentRound: roundIndex,
      totalRounds,
      outputPaths: outputPaths ?? [],
    });
    runtimeHost.emit('updateConversationProgress', {
      streamId,
      progress: {
        conversationTurns: roundIndex + 1,
        toolCallCount: 0,
      },
    });
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
): Promise<AgentFlowResult> {
  const { streamId } = ctx;
  let toolUseTurns = 0;
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
            toolUseTurns++;
            ctx.runtimeHost.emit('updateConversationProgress', {
              streamId,
              progress: {
                conversationTurns: toolUseTurns,
                toolCallCount: update.toolCallCount,
              },
            });
          }
          options.onProgress?.(update);
        },
        onFollowUpConsumed: () => {
          publishRuntimeQueuedFollowUps(ctx.runtimeHost, ctx.streamId);
          options.onFollowUpConsumed?.();
        },
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
    throw new AgentFlowError(
      getSdkErrorMessage(err),
      buildToolUseFlowResult(
        failedResult,
        ctx.executionId,
        streamId,
        ctx.attachedMemoryMisses,
      ),
      { cause: err },
    );
  }
}

/**
 * Run the reflection (workflow) flow for a single agent execution.
 *
 * Owns all workflow-specific wiring: per-round progress callbacks and usage
 * recording. The caller (`executeAgent`) owns lifecycle and stream-status.
 */
async function runReflectionAgent(
  ctx: AgentLaunchContext,
  setting: AgentWorkflowSetting,
  options: Pick<ExecuteAgentOptions, 'onProgress'>,
): Promise<AgentFlowResult> {
  const { streamId } = ctx;
  const onRoundCompleted = createRoundProgressCallback(
    ctx.executionId,
    streamId,
    ctx.runtimeHost,
    options.onProgress,
  );
  const onRoundFinalized = createUsageRecordingCallback(ctx);
  const result = await runReflectionFlow({
    ...ctx,
    ...createInterruptCallbacks(),
    onRoundFinalized,
    setting,
    parentStage: ctx.parentStage,
    onRoundCompleted,
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
  /** Fires on meaningful progress: todo changes, round completions, tool call milestones. */
  onProgress?: (update: SubagentProgressUpdate) => void;
  /** Stop a tool-use execution after one model/tool cycle instead of waiting for follow-up input. */
  stopAfterCycle?: boolean;
  /** Hide tools whose approval prompts cannot be answered in this host mode. */
  approvalPromptsUnavailable?: boolean;
  /** Hide tools unavailable because the current host/runtime cannot support them. */
  runtimeUnavailableTools?: readonly string[];
  /** Session owning this run's coordination state. Defaults to the process session. */
  session?: SessionHandle;
  /** Fires after flow completes but before executionRegistry.untrack, so follow-ups are enqueued before waiters resolve. */
  onCompleted?: (result: AgentFlowResult) => void | Promise<void>;
  /** Fires when a subagent fails and should report the failure to its orchestrator. */
  onError?: (error: unknown, result: AgentFlowResult) => void | Promise<void>;
  /** Fires once with the live per-run handle right after it is tracked (F-2). */
  onRun?: (handle: AgentRunHandle) => void | Promise<void>;
}

export async function executeAgent(
  configPayload: AgentConfigPayload,
  executionId: ExecutionId | undefined,
  options: ExecuteAgentOptions,
): Promise<AgentFlowResult> {
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
  });
  ctx.delegationDepth = options.delegationDepth ?? 0;
  ctx.approvalPromptsUnavailable = options.approvalPromptsUnavailable;
  ctx.runtimeUnavailableTools = options.runtimeUnavailableTools;
  ctx.stopAfterCycle = options.stopAfterCycle;
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
    return runFlowWithLifecycle(
      ctx,
      async (handle) => {
        // Pre-execution UI setup (RUNNING is set by runFlowWithLifecycle)
        if (executionId) await ensureRunDir(executionId);
        logger.info(`Starting task execution (streamId: ${streamId})`);
        logger.info(`Input file: ${config.inputFiles[0] ?? '(none)'}`);
        logger.debug(
          `Stream ID: ${streamId}, Agent: ${config.agent}, Model: ${config.model}`,
        );
        logger.debug(`Output files: ${config.outputFiles?.length ?? 0}`);
        // Subagents don't need to force-open the progress board or show notifications —
        // the orchestrator's stream is already visible.
        if (!isSubagent && !isRuntimeProgressViewVisible()) {
          ctx.runtimeHost.emit('requestEnsureProgressView', {
            fallbackNotification: buildFallbackNotification(config),
          });
        }
        ctx.runtimeHost.emit('setTaskState', {
          streamId,
          executionId,
          taskState: buildRuntimeTaskStateFromConfig(config),
        });

        logger.info(`Executing ${config.agent} with model ${config.model}`);

        if (setting.agentCategory === AgentCategory.ToolUse) {
          return runToolUseAgent(ctx, handle, setting, options);
        }
        return runReflectionAgent(ctx, setting, options);
      },
      {
        isSubagent,
        parentStreamId: options.parentStreamId,
        onCompleted: options.onCompleted,
        onError: options.onError,
        onRun: options.onRun,
      },
    );
  });
}

export interface ResumeToolUseFromSnapshotOptions {
  /** Hide tools whose approval prompts cannot be answered in this host mode. */
  readonly approvalPromptsUnavailable?: boolean;
  /** Hide tools unavailable because the current host/runtime cannot support them. */
  readonly runtimeUnavailableTools?: readonly string[];
  /** Session owning this run's coordination state. Defaults to the process session. */
  readonly session?: SessionHandle;
  readonly onRun?: (handle: AgentRunHandle) => void | Promise<void>;
  readonly setupSession?: (session: IToolUseSession) => void;
}

export async function resumeToolUseFromSnapshot(
  snapshot: ToolUseSessionSnapshot,
  runtimeHost: AgentRuntimeHost,
  options: ResumeToolUseFromSnapshotOptions = {},
): Promise<void> {
  const ctx = await buildAgentLaunchContext({
    configPayload: snapshot.agentConfig,
    executionId: snapshot.executionId,
    runtimeHost,
    streamTabIdOverride: snapshot.streamId,
    // resumeCommand surfaces its own warning toast on failure; skip the
    // bus-level error to avoid double-notifying.
    suppressErrorNotification: true,
    session: options.session,
  });
  // Recover delegation depth from the persisted parent-execution chain
  // so resumed subagents remain gated by the nested-delegation policy
  // instead of silently promoting to root.
  ctx.delegationDepth = await computeDelegationDepthFromStorage(
    snapshot.executionId,
  );
  ctx.approvalPromptsUnavailable = options.approvalPromptsUnavailable;
  ctx.runtimeUnavailableTools = options.runtimeUnavailableTools;
  const { setting, streamId } = ctx;

  await withExecutionRunContext(ctx, async () => {
    if (setting.agentCategory !== AgentCategory.ToolUse) {
      throw new AgentError(
        'Attempted to resume a non tool-use agent with resumeToolUseFromSnapshot.',
      );
    }

    const isSubagent = (ctx.delegationDepth ?? 0) > 0;
    await runFlowWithLifecycle(
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
            onFollowUpConsumed: () =>
              publishRuntimeQueuedFollowUps(ctx.runtimeHost, ctx.streamId),
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
      { isSubagent, onRun: options.onRun },
    );
  });
}
