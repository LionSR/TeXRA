import { registerExecution } from '@agent/storage';

import type { ValidatedExecutionRequest } from '@agent/core/state/executionRequests';
import type { ExecutionId } from '@shared/schemas';
import { generateExecutionId } from '@utils/core';
import { applyHelperModelPreference } from './helperModelPreference';
import { executeAgent, type ExecuteAgentOptions } from './executeAgent';
import type { AgentFlowResult, WorkflowFlowResult } from './AgentFlowResult';

/**
 * Options for `runAgent`. Fields shared with the lower-level `executeAgent`
 * are picked from `ExecuteAgentOptions` (and forwarded as-is) so the two
 * option types can't drift apart silently; see that interface for their docs.
 */
export interface RunAgentOptions extends Pick<
  ExecuteAgentOptions,
  | 'runtimeHost'
  | 'enforceCategory'
  | 'stopAfterCycle'
  | 'approvalPromptsUnavailable'
  | 'runtimeUnavailableTools'
  | 'toolEditApprovalHandler'
  | 'session'
  | 'modelHandlerCompatibilityKey'
  | 'onRun'
> {
  openWorkflowOutput?: (result: WorkflowFlowResult) => Promise<void>;
  registerExecution?: boolean;
  /**
   * Opt-in set by the "fix LaTeX" VS Code actions (Fix-Compilation command, the
   * progress-view compile fixer): run the launched agent on the configured
   * helper model instead of the selected one. Off for a direct main-view launch,
   * the CLI, and orchestrator delegations, which all keep the chosen model.
   */
  preferHelperModel?: boolean;
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
 * lineage; for those, drop to the lower-level engine `executeAgent`, where the
 * caller owns executionId generation and `registerExecution`.
 */
export async function runAgent(
  request: ValidatedExecutionRequest,
  options: RunAgentOptions,
): Promise<AgentFlowResult> {
  const executionId =
    request.executionId ?? (generateExecutionId() as ExecutionId);
  const shouldRegister =
    options.registerExecution ?? request.executionId === undefined;

  // Only the "fix LaTeX" VS Code actions opt in (preferHelperModel); the agent
  // then runs on the configured helper model. A direct main-view launch keeps the
  // model the user picked. Resolved before registerExecution so the stored record
  // and the run agree.
  const config = options.preferHelperModel
    ? await applyHelperModelPreference(request.config)
    : request.config;

  if (shouldRegister) {
    await registerExecution(
      executionId,
      config,
      config.agent,
      undefined,
      config.agentCategory,
    );
  }

  const result = await executeAgent(config, executionId, {
    runtimeHost: options.runtimeHost,
    enforceCategory: options.enforceCategory,
    stopAfterCycle: options.stopAfterCycle,
    approvalPromptsUnavailable: options.approvalPromptsUnavailable,
    runtimeUnavailableTools: options.runtimeUnavailableTools,
    toolEditApprovalHandler: options.toolEditApprovalHandler,
    session: options.session,
    modelHandlerCompatibilityKey: options.modelHandlerCompatibilityKey,
    onRun: options.onRun,
  });
  if (result.category === 'workflow') {
    await options.openWorkflowOutput?.(result);
  }
  return result;
}
