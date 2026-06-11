import {
  getFirstRunDone,
  setFirstRunDone,
} from '@controllers/onboarding/onboardingFunnel';
import { platform } from '@platform/platform';
import { writeTerminalStatus } from '@agent/storage';
import { logSdkError } from '@agent/trace';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  AGENT_ERROR_OUTCOME,
  AgentError,
  classifyAgentError,
  getSdkErrorMessage,
} from '@common/errors';
import { projectRunOutcome } from '@common/constants/streamStatus';
import { INSTRUCTION_ACTION } from '@eventBus/ProgressEventBus';
import { createChannelTrace } from '@logger';
import { RUN_OUTCOME, STREAM_STATUS, type StreamTabId } from '@shared/schemas';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { agentName as baseAgentName } from '@shared/schemas/agent';

import { AgentExecutionHandle, executionRegistry } from './executionRegistry';
import {
  getAgentFlowErrorResult,
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
  const agentIdentifier = ctx.config.agent;
  const category =
    ctx.setting.agentCategory === AgentCategory.ToolUse
      ? 'toolUse'
      : 'workflow';
  const parentStreamId = options?.parentStreamId ?? streamId;
  const handle = new AgentExecutionHandle(
    ctx.executionId,
    parentStreamId,
    streamId,
    agentIdentifier,
    category,
    ctx.runtimeHost,
    ctx.coordinators,
  );
  executionRegistry.track(handle);
  try {
    // The lifecycle owns every stream-status transition: RUNNING here,
    // terminal states in the success/error arms below. Runners must not
    // set stream status themselves.
    ctx.streamStatus.set(streamId, STREAM_STATUS.RUNNING, {
      runtimeHost: ctx.runtimeHost,
    });
    const result = await runner(handle);
    await options?.onCompleted?.(result);
    // The flow's outcome is the canonical terminal fact; everything below is
    // one row of the projection table. No other layer may re-derive these.
    const projection = projectRunOutcome(result.outcome);
    await writeTerminalStatus(
      ctx.executionId,
      projection.executionStatus,
    ).catch(() => {});

    // Onboarding funnel (PRD: agent-native onboarding): State 1 ends when any
    // real run completes. The setup conversation itself doesn't count, but the
    // demo it delegates does (subagent runs land here too). Best-effort: a
    // state write failure must never affect the run.
    if (
      result.outcome === RUN_OUTCOME.COMPLETED &&
      baseAgentName(agentIdentifier) !== SETUP_AGENT_NAME
    ) {
      try {
        if (!getFirstRunDone(platform().globalState)) {
          await setFirstRunDone(platform().globalState, true);
        }
      } catch {
        // Ignore: the flag is a UX nicety, never run-critical.
      }
    }

    executionRegistry.untrack(ctx.executionId);
    ctx.parentStage.end(projection.endGroupStatus);

    if (!ctx.streamStatus.shouldPreserveOnCompletion(streamId)) {
      ctx.streamStatus.set(streamId, projection.streamStatus, {
        runtimeHost: ctx.runtimeHost,
        terminalStatus: projection.executionStatus,
      });
    }
    logger.debug(`Task completed with outcome: ${result.outcome}`);
    return result;
  } catch (err) {
    const kind = classifyAgentError(err);
    const outcome = AGENT_ERROR_OUTCOME[kind];
    const projection = projectRunOutcome(outcome);
    await writeTerminalStatus(
      ctx.executionId,
      projection.executionStatus,
    ).catch(() => {});
    const sdkMsg = getSdkErrorMessage(err);
    const errorMsg = `Error executing agent ${agentIdentifier}: ${sdkMsg}`;

    // Root-agent failures are surfaced in the stream log. Subagent failures
    // are delivered to the orchestrator below, so avoid adding a second
    // wrapper error that makes a child failure look like the parent failed.
    if (kind !== 'abort' && !options?.isSubagent) {
      logSdkError(ctx.logger, errorMsg, err, {
        operation: `execute ${agentIdentifier}`,
      });
    }

    ctx.parentStage.end(projection.endGroupStatus);
    ctx.streamStatus.set(streamId, projection.streamStatus, {
      runtimeHost: ctx.runtimeHost,
      terminalStatus: projection.executionStatus,
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

    if (options?.isSubagent) {
      const result =
        getAgentFlowErrorResult(err) ??
        buildTerminalFlowResult(
          category,
          outcome,
          ctx.executionId,
          streamId,
          ctx.attachedMemoryMisses,
        );
      try {
        await options.onError?.(err, result);
      } catch (deliveryError) {
        logger.warn(
          `Failed to deliver subagent error for ${agentIdentifier}: ${getSdkErrorMessage(deliveryError)}`,
        );
      }
      executionRegistry.untrack(ctx.executionId);
      return result;
    }

    executionRegistry.untrack(ctx.executionId);
    if (kind === 'abort') {
      return buildTerminalFlowResult(
        category,
        outcome,
        ctx.executionId,
        streamId,
        ctx.attachedMemoryMisses,
      );
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
