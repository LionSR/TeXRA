import { writeTerminalStatus } from '@agent/storage';
import { logSdkError } from '@agent/trace';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  AgentError,
  classifyAgentError,
  getSdkErrorMessage,
} from '@common/errors';
import { INSTRUCTION_ACTION } from '@eventBus/ProgressEventBus';
import { createChannelTrace } from '@logger';
import {
  STREAM_STATUS,
  END_GROUP_STATUS,
  EXECUTION_STATUS,
  type StreamTabId,
} from '@shared/schemas';

import { AgentExecutionHandle, executionRegistry } from './executionRegistry';
import { StreamStatusService } from './StreamStatusService';
import {
  buildTerminalFlowResult,
  type AgentFlowResult,
} from './AgentFlowResult';
import type { AgentLaunchContext } from './AgentLaunchContext';

const logger = createChannelTrace('agentRunLifecycle');

export interface RunFlowLifecycleOptions {
  isSubagent?: boolean;
  parentStreamId?: StreamTabId;
  onCompleted?: (result: AgentFlowResult) => void | Promise<void>;
  onError?: (error: unknown, result: AgentFlowResult) => void | Promise<void>;
}

/**
 * Wraps a flow runner with full agent run lifecycle management: execution
 * registry tracking, stream-status transitions, error classification, user
 * notifications, and resource disposal.
 *
 * Separating this from `executeAgent` keeps the orchestrator focused on flow
 * routing while this module owns the invariants that must hold across every
 * agent run (registration, status accounting, error surfacing, cleanup).
 */
export async function runFlowWithLifecycle(
  ctx: AgentLaunchContext,
  runner: (handle: AgentExecutionHandle) => Promise<AgentFlowResult>,
  options?: RunFlowLifecycleOptions,
): Promise<AgentFlowResult> {
  const { streamId } = ctx;
  const agentName = ctx.config.agent;
  const category =
    ctx.setting.agentCategory === AgentCategory.ToolUse
      ? 'toolUse'
      : 'workflow';
  const parentStreamId = options?.parentStreamId ?? streamId;
  const handle = new AgentExecutionHandle(
    ctx.executionId,
    parentStreamId,
    streamId,
    agentName,
    category,
    ctx.runtimeHost,
    ctx.coordinators,
  );
  executionRegistry.track(handle);
  try {
    const result = await runner(handle);
    await options?.onCompleted?.(result);
    const terminalStatus =
      result.status === END_GROUP_STATUS.ERROR
        ? EXECUTION_STATUS.ERROR
        : EXECUTION_STATUS.COMPLETED;
    await writeTerminalStatus(ctx.executionId, terminalStatus).catch(() => {});

    executionRegistry.untrack(ctx.executionId);
    ctx.parentStage.end(result.status);

    if (!StreamStatusService.shouldPreserveOnCompletion(streamId)) {
      const status =
        result.status === 'error' ? STREAM_STATUS.ERROR : STREAM_STATUS.STOPPED;
      StreamStatusService.set(streamId, status, {
        runtimeHost: ctx.runtimeHost,
        terminalStatus,
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
    executionRegistry.untrack(ctx.executionId);
    const sdkMsg = getSdkErrorMessage(err);
    const errorMsg = `Error executing agent ${agentName}: ${sdkMsg}`;

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
      terminalStatus,
    });

    // Subagents propagate errors to the orchestrator via FollowUpQueue —
    // don't show VS Code popups that would confuse the user.
    if (!options?.isSubagent) {
      if (kind === 'disk-full') {
        ctx.runtimeHost.emit('requestShowError', {
          message: sdkMsg,
        });
      } else if (kind === 'missing-api-key') {
        ctx.runtimeHost.emit('requestShowInstruction', {
          key: 'missingApiKey',
          message:
            'API key not found. Set your API key in the extension settings and run again.',
          actions: [
            INSTRUCTION_ACTION.SET_API_KEY,
            INSTRUCTION_ACTION.OPEN_CONFIGURATION_GUIDE,
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
