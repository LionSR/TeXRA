import { registerExecution } from '@agent/storage';

import type { ValidatedExecutionRequest } from '@agent/core/executionRequests';
import type { ExecutionId } from '@shared/schemas';
import { generateExecutionId } from '@utils/core/executionId';
import { executeAgent } from './executeAgent';
import type { AgentRuntimeHost } from './AgentRuntimeHost';
import type { AgentFlowResult, WorkflowFlowResult } from './AgentFlowResult';

export interface RunAgentOptions {
  runtimeHost: AgentRuntimeHost;
  openWorkflowOutput?: (result: WorkflowFlowResult) => Promise<void>;
  enforceCategory?: boolean;
  registerExecution?: boolean;
  stopAfterCycle?: boolean;
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
  const shouldRegister =
    options.registerExecution ?? request.executionId === undefined;

  if (shouldRegister) {
    await registerExecution(
      executionId,
      request.config,
      request.config.agent,
      undefined,
      request.config.agentCategory,
    );
  }

  const result = await executeAgent(request.config, executionId, {
    runtimeHost: options.runtimeHost,
    enforceCategory: options.enforceCategory,
    stopAfterCycle: options.stopAfterCycle,
  });
  if (result.category === 'workflow') {
    await options.openWorkflowOutput?.(result);
  }
  return result;
}
