import { registerExecution } from '@agent/storage';

import type { ValidatedExecutionRequest } from '@agent/core/executionRequests';
import type { ExecutionId } from '@shared/schemas';
import { generateExecutionId } from '@utils/core/executionId';
import { executeAgent } from './executeAgent';
import type { AgentRuntimeHost } from './AgentRuntimeHost';
import type { AgentFlowResult, WorkflowFlowResult } from './AgentFlowResult';

export interface RunExecutionRequestOptions {
  runtimeHost: AgentRuntimeHost;
  openWorkflowOutput?: (result: WorkflowFlowResult) => Promise<void>;
  enforceCategory?: boolean;
  registerExecution?: boolean;
}

export async function runValidatedExecutionRequest(
  request: ValidatedExecutionRequest,
  options: RunExecutionRequestOptions,
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
  });
  if (result.category === 'workflow') {
    await options.openWorkflowOutput?.(result);
  }
  return result;
}
