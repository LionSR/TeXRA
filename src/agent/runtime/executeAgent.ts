import * as path from 'path';

import { writeTerminalStatus } from '@agent/storage';
import { logSdkError } from '@agent/trace';
import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import {
  runToolUseFlow,
  type IToolUseSession,
} from '@agent/implementations/flows/tooluse';
import {
  runReflectionFlow,
  type RunReflectionFlowResult,
} from '@agent/implementations/flows/reflection/runReflectionFlow';
import {
  type AgentConfig,
  type AgentConfigPayload,
} from '@agent/core/AgentConfig';
import { AgentCategory, isWorkflowSetting } from '@agent/core/AgentDataclass';
import { computeDelegationDepthFromStorage } from '@agent/runtime/delegationPolicy';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';
import {
  AgentError,
  classifyAgentError,
  getSdkErrorMessage,
} from '@common/errors';
import { createChannelTrace } from '@logger';
import {
  STREAM_STATUS,
  END_GROUP_STATUS,
  EXECUTION_STATUS,
  type EndGroupStatus,
  type StreamTabId,
  type ExecutionId,
  type OutputFileInfo,
  type RoundOutput,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import { TaskRunFileService } from '@utils/files';
import { ensureRunDir } from '@utils/files/taskRunStorage';

import {
  buildAgentLaunchContext,
  withExecutionRunContext,
  type AgentLaunchContext,
} from './AgentLaunchContext';
import { createInterruptCallbacks } from './InterruptManager';
import {
  trackExecution,
  untrackExecution,
  updateExecutionProgress,
  AgentExecutionHandle,
} from './executionRegistry';
import { generateSessionDescription } from './sessionDescription';
import { getRunStorageService } from './RunStorageService';
import { StreamStatusService } from './StreamStatusService';
import type { AgentRuntimeHost } from './AgentRuntimeHost';
import type {
  AgentFlowResult,
  CompileFailureSummary,
  OutputFileSummary,
} from './AgentFlowResult';

export { getAgentPath } from './AgentLaunchContext';

const CHANNEL = 'executeAgent';
const logger = createChannelTrace(CHANNEL);

/** Map workflow RoundOutput[] to OutputFileSummary[] for AgentFlowResult. */
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
      originalPath: o.lineage?.original?.absolutePath ?? null,
      added: o.diff?.added ?? null,
      removed: o.diff?.removed ?? null,
    })),
  );
}

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
): AgentFlowResult {
  return {
    category: 'workflow',
    status: result.status,
    outputs: toOutputSummaries(result.roundOutputs),
    compileFailures: toCompileFailureSummaries(result.roundOutputs),
    executionId,
    streamId,
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
    updateExecutionProgress(executionId, {
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

async function runFlowWithLifecycle(
  ctx: AgentLaunchContext,
  streamId: StreamTabId,
  agentName: string,
  runner: () => Promise<AgentFlowResult>,
  options?: {
    isSubagent?: boolean;
    category?: 'workflow' | 'toolUse';
    parentStreamId?: StreamTabId;
    onCompleted?: (result: AgentFlowResult) => void | Promise<void>;
    onError?: (error: unknown, result: AgentFlowResult) => void | Promise<void>;
  },
): Promise<AgentFlowResult> {
  const category = options?.category ?? 'workflow';
  const parentStreamId = options?.parentStreamId ?? streamId;
  const handle = new AgentExecutionHandle(
    ctx.executionId,
    parentStreamId,
    streamId,
    agentName,
    category,
    ctx.runtimeHost,
  );
  trackExecution(handle);
  try {
    const result = await runner();
    await options?.onCompleted?.(result);
    await writeTerminalStatus(
      ctx.executionId,
      result.status === END_GROUP_STATUS.ERROR
        ? EXECUTION_STATUS.ERROR
        : EXECUTION_STATUS.COMPLETED,
    ).catch(() => {});

    untrackExecution(ctx.executionId);
    ctx.parentStage.end(result.status);

    if (!StreamStatusService.shouldPreserveOnCompletion(streamId)) {
      const status =
        result.status === 'error' ? STREAM_STATUS.ERROR : STREAM_STATUS.STOPPED;
      StreamStatusService.set(streamId, status, {
        runtimeHost: ctx.runtimeHost,
      });
    }
    logger.debug(`Task completed with status: ${result.status}`);
    return result;
  } catch (err) {
    const kind = classifyAgentError(err);
    const status =
      kind === 'abort' ? END_GROUP_STATUS.STOPPED : END_GROUP_STATUS.ERROR;
    const terminalStatus =
      kind === 'abort' ? EXECUTION_STATUS.INTERRUPTED : EXECUTION_STATUS.ERROR;
    const streamStatus =
      kind === 'abort' ? STREAM_STATUS.STOPPED : STREAM_STATUS.ERROR;
    await writeTerminalStatus(ctx.executionId, terminalStatus).catch(() => {});
    untrackExecution(ctx.executionId);
    const errorMsg = `Error executing agent ${agentName}: ${getSdkErrorMessage(err)}`;

    // Root-agent failures are surfaced in the stream log. Subagent failures
    // are delivered to the orchestrator below, so avoid adding a second
    // wrapper error that makes a child failure look like the parent failed.
    if (kind !== 'abort' && !options?.isSubagent) {
      logSdkError(ctx.logger, errorMsg, err, {
        operation: `execute ${agentName}`,
      });
    }

    ctx.parentStage.end(status);
    StreamStatusService.set(streamId, streamStatus, {
      runtimeHost: ctx.runtimeHost,
    });

    // Subagents propagate errors to the orchestrator via FollowUpQueue —
    // don't show VS Code popups that would confuse the user.
    if (!options?.isSubagent) {
      if (kind === 'disk-full') {
        ctx.runtimeHost.emit('requestShowError', {
          message: getSdkErrorMessage(err),
        });
      } else if (kind === 'missing-api-key') {
        ctx.runtimeHost.emit('requestShowInstruction', {
          key: 'missingApiKey',
          message:
            'API key not found. Set your API key in the extension settings and run again.',
          actions: [
            { title: 'Set API Key', command: 'texra.setApiKey' },
            {
              title: 'Open Settings Guide',
              command: 'texra.openDoc',
              args: ['configuration'],
            },
          ],
          showSuppress: false,
        });
      } else if (kind === 'unexpected') {
        ctx.runtimeHost.emit('requestShowError', {
          message: errorMsg,
        });
      }
    }

    if (kind === 'abort') {
      return buildTerminalFlowResult(
        category,
        END_GROUP_STATUS.STOPPED,
        ctx.executionId,
        streamId,
      );
    }

    if (options?.isSubagent) {
      const result = buildTerminalFlowResult(
        category,
        END_GROUP_STATUS.ERROR,
        ctx.executionId,
        streamId,
      );
      try {
        await options.onError?.(err, result);
      } catch (deliveryError) {
        logger.warn(
          `Failed to deliver subagent error for ${agentName}: ${getSdkErrorMessage(deliveryError)}`,
        );
      }
      return result;
    }

    throw new AgentError(errorMsg, { cause: err });
  } finally {
    // Release long-lived resources (e.g., WebSocket connections, keepalive intervals)
    // to prevent leaks when handler instances are discarded after execution.
    ctx.modelHandler.dispose();
    // Drop the run-trace subscribers (channel sink + transcript recorder) so
    // they don't pile up across many agent runs.
    ctx.disposeTrace();
  }
}

function buildTerminalFlowResult(
  category: 'workflow' | 'toolUse',
  status: EndGroupStatus,
  executionId: ExecutionId,
  streamId: StreamTabId,
): AgentFlowResult {
  if (category === 'toolUse') {
    return { category, status, executionId, streamId };
  }
  return {
    category,
    status,
    executionId,
    streamId,
    outputs: [],
    compileFailures: [],
  };
}

function buildFallbackNotification(config: AgentConfig): {
  agentName: string;
  modelName: string;
  inputName: string;
  outputInfo: string;
} {
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
  onBeforeWaiting?: (
    lastResponse: string | undefined,
    touchedFiles: string[],
  ) => boolean | void | Promise<boolean | void>;
  /** Fires when a tool-use session consumes queued follow-up instructions. */
  onFollowUpConsumed?: () => void;
  /** Fires on meaningful progress: todo changes, round completions, tool call milestones. */
  onProgress?: (update: SubagentProgressUpdate) => void;
  /** Fires after flow completes but BEFORE untrackExecution, so follow-ups are enqueued before waiters resolve. */
  onCompleted?: (result: AgentFlowResult) => void | Promise<void>;
  /** Fires when a subagent fails and should report the failure to its orchestrator. */
  onError?: (error: unknown, result: AgentFlowResult) => void | Promise<void>;
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
  });
  ctx.delegationDepth = options.delegationDepth ?? 0;
  return withExecutionRunContext(ctx, async () => {
    const { setting, streamId, config } = ctx;
    const { agent: agentName } = config;
    const { isSubagent } = options;
    const category =
      setting.agentCategory === AgentCategory.ToolUse ? 'toolUse' : 'workflow';

    // Fire-and-forget: generate AI session description from the user's instruction.
    // Triggered at the start so cancelled/errored sessions still get descriptions.
    // Applies to all agents including subagents so their progress tabs show
    // meaningful descriptions in multi-agent pipelines.
    generateSessionDescription(
      ctx.executionId,
      streamId,
      config,
      ctx.runtimeHost,
    ).catch(() => {});
    return runFlowWithLifecycle(
      ctx,
      streamId,
      agentName,
      async () => {
        // Pre-execution UI setup
        if (executionId) await ensureRunDir(executionId);
        StreamStatusService.set(streamId, STREAM_STATUS.RUNNING, {
          runtimeHost: ctx.runtimeHost,
        });
        logger.info(`Starting task execution (streamId: ${streamId})`);
        logger.info(`Input file: ${config.inputFiles[0] ?? '(none)'}`);
        logger.debug(
          `Stream ID: ${streamId}, Agent: ${config.agent}, Model: ${config.model}`,
        );
        logger.debug(`Output files: ${config.outputFiles?.length ?? 0}`);
        // Subagents don't need to force-open the progress board or show notifications —
        // the orchestrator's stream is already visible.
        if (!isSubagent && !getRunStorageService().isViewVisible()) {
          ctx.runtimeHost.emit('requestEnsureProgressView', {
            fallbackNotification: buildFallbackNotification(config),
          });
        }
        ctx.runtimeHost.emit('setTaskState', {
          streamId,
          executionId,
          taskState: agentConfigToTaskState(config),
        });

        const taskStage = logger.openStage(
          `Task: ${agentName}@${config.model}`,
        );
        return taskStage.run(async () => {
          logger.info(`Executing ${agentName} with model ${config.model}`);
          const interrupts = createInterruptCallbacks();

          if (setting.agentCategory === AgentCategory.ToolUse) {
            let toolUseTurns = 0;
            const result = await runToolUseFlow({
              ...ctx,
              ...interrupts,
              onRoundFinalized: (run) => ctx.usageMonitor.recordUsage(run),
              setting,
              isSubagent,
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
                ctx.runtimeHost.emit('updateQueuedFollowUps', {
                  streamId: ctx.streamId,
                });
                options.onFollowUpConsumed?.();
              },
              onModelChanged: (modelHandler, model) => {
                ctx.config.model = model;
                ctx.usageMonitor.setModelInfo({
                  capabilities: modelHandler.capabilities,
                  config: modelHandler.config,
                });
              },
            });
            return {
              category: 'toolUse' as const,
              status: result.status,
              lastResponse: result.lastResponse,
              touchedFiles: result.touchedFiles,
              executionId: ctx.executionId,
              streamId,
            };
          }

          const onRoundCompleted = createRoundProgressCallback(
            ctx.executionId,
            streamId,
            ctx.runtimeHost,
            options.onProgress,
          );
          const result = await runReflectionFlow({
            ...ctx,
            ...interrupts,
            onRoundFinalized: (run) => ctx.usageMonitor.recordUsage(run),
            setting,
            parentStage: ctx.parentStage,
            onRoundCompleted,
          });
          return buildWorkflowFlowResult(result, ctx.executionId, streamId);
        });
      },
      {
        isSubagent,
        category,
        parentStreamId: options.parentStreamId,
        onCompleted: options.onCompleted,
        onError: options.onError,
      },
    );
  });
}

export async function resumeToolUseFromSnapshot(
  snapshot: ToolUseSessionSnapshot,
  runtimeHost: AgentRuntimeHost,
  setupSession?: (session: IToolUseSession) => void,
): Promise<void> {
  const ctx = await buildAgentLaunchContext({
    configPayload: snapshot.agentConfig,
    executionId: snapshot.executionId,
    runtimeHost,
    streamTabIdOverride: snapshot.streamId,
    // resumeCommand surfaces its own warning toast on failure; skip the
    // bus-level error to avoid double-notifying.
    suppressErrorNotification: true,
  });
  // Recover delegation depth from the persisted parent-execution chain
  // so resumed subagents remain gated by the nested-delegation policy
  // instead of silently promoting to root.
  ctx.delegationDepth = await computeDelegationDepthFromStorage(
    snapshot.executionId,
  );
  const { setting, streamId } = ctx;

  await withExecutionRunContext(ctx, async () => {
    if (setting.agentCategory !== AgentCategory.ToolUse) {
      throw new AgentError(
        'Attempted to resume a non tool-use agent with resumeToolUseFromSnapshot.',
      );
    }

    await runFlowWithLifecycle(
      ctx,
      streamId,
      snapshot.agentConfig.agent,
      async () => {
        StreamStatusService.set(streamId, STREAM_STATUS.RUNNING, {
          runtimeHost: ctx.runtimeHost,
        });

        const result = await runToolUseFlow(
          {
            ...ctx,
            ...createInterruptCallbacks(),
            onRoundFinalized: (run) => ctx.usageMonitor.recordUsage(run),
            setting,
            resumeSnapshot: snapshot,
            // Derive from the recovered parent chain: any execution with a
            // parent is a subagent. Without this, the rebuilt system prompt
            // would drop subagent-specific instructions (e.g. the shared
            // /memories protocol) that the fresh run had included.
            isSubagent: (ctx.delegationDepth ?? 0) > 0,
            onFollowUpConsumed: () =>
              ctx.runtimeHost.emit('updateQueuedFollowUps', {
                streamId: ctx.streamId,
              }),
          },
          undefined,
          setupSession ? (context) => setupSession(context.session) : undefined,
        );
        return {
          category: 'toolUse' as const,
          status: result.status,
          lastResponse: result.lastResponse,
          touchedFiles: result.touchedFiles,
          executionId: ctx.executionId,
          streamId,
        };
      },
      { category: 'toolUse' },
    );
  });
}
