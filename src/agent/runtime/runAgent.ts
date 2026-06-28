import { registerExecution } from '@agent/storage';

import type { ValidatedExecutionRequest } from '@agent/core/execution/executionRequests';
import type { ToolUseBeforeWaitingCallback } from '@agent/implementations/flows/tooluse/ToolUseServices';
import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';
import {
  EXECUTION_STATUS,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { generateExecutionId } from '@utils/core/executionId';
import { executeAgent } from './executeAgent';
import { repairRuntimeHistoryTerminalStatus } from './historyCommands';
import type { AgentFlowResult, WorkflowFlowResult } from './AgentFlowResult';
import type { AgentRunHandle } from './executionRegistry';
import type { SessionHandle } from './SessionHandle';

export interface RunAgentOptions {
  runtimeHost: AgentRuntimeHost;
  openWorkflowOutput?: (result: WorkflowFlowResult) => Promise<void>;
  enforceCategory?: boolean;
  registerExecution?: boolean;
  stopAfterCycle?: boolean;
  approvalPromptsUnavailable?: boolean;
  runtimeUnavailableTools?: readonly string[];
  /** Fires once the runtime has allocated the execution id for this run. */
  onExecutionIdAllocated?: (executionId: ExecutionId) => void;
  /** Fires with the real stream id before the stream is activated. */
  onStreamResolved?: (streamId: StreamTabId) => void;
  /** Fires before a tool-use run enters WAITING, delivering the interim text. */
  onBeforeWaiting?: ToolUseBeforeWaitingCallback;
  /** Session owning this run's coordination state. Defaults to the process session. */
  session?: SessionHandle;
  /**
   * Fires once with the live per-run handle right after it is tracked (F-2):
   * `handle.result` settles with the terminal outcome, `handle.trace` is the
   * run's event channel, and the handle can interrupt via the session. The
   * returned promise is unchanged — this is additive, post-launch exposure.
   */
  onRun?: (handle: AgentRunHandle) => void | Promise<void>;
}

/**
 * START HERE — the high-level entry every host uses to run an agent.
 *
 * Validates-then-runs: assigns an executionId when the request omits one (a
 * fresh run), registers fresh runs in the execution store (resume reuses the
 * record; override via `registerExecution`), runs the agent, and — for a
 * workflow result — invokes `openWorkflowOutput` so the host can surface output.
 *
 * Use this unless you need per-chunk streaming/lifecycle callbacks or subagent
 * lineage; for those, drop to the lower-level engine `executeAgent` (exported
 * as `runAgentStream` from `@texra/core`), where the caller owns executionId
 * generation and `registerExecution`.
 */
export async function runAgent(
  request: ValidatedExecutionRequest,
  options: RunAgentOptions,
): Promise<AgentFlowResult> {
  const executionId =
    request.executionId ?? (generateExecutionId() as ExecutionId);
  options.onExecutionIdAllocated?.(executionId);
  const shouldRegister =
    options.registerExecution ?? request.executionId === undefined;
  let historyRepairCandidate = request.executionId !== undefined;

  if (shouldRegister) {
    await registerExecution(
      executionId,
      request.config,
      request.config.agent,
      undefined,
      request.config.agentCategory,
    );
    historyRepairCandidate = true;
  }

  let result: AgentFlowResult;
  try {
    result = await executeAgent(request.config, executionId, {
      runtimeHost: options.runtimeHost,
      enforceCategory: options.enforceCategory,
      stopAfterCycle: options.stopAfterCycle,
      approvalPromptsUnavailable: options.approvalPromptsUnavailable,
      runtimeUnavailableTools: options.runtimeUnavailableTools,
      onStreamResolved: options.onStreamResolved,
      onBeforeWaiting: options.onBeforeWaiting,
      session: options.session,
      onRun: options.onRun,
    });
  } catch (err) {
    if (historyRepairCandidate) {
      await repairRuntimeHistoryTerminalStatus(
        executionId,
        EXECUTION_STATUS.ERROR,
      ).catch(() => {});
    }
    throw err;
  }
  if (result.category === 'workflow') {
    await options.openWorkflowOutput?.(result);
  }
  return result;
}
