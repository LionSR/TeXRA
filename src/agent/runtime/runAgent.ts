import { registerExecution } from '@agent/storage';

import type { ValidatedExecutionRequest } from '@agent/core/state/executionRequests';
import type { ToolEditApprovalPort } from '@platform/interfaces/toolEditApproval';
import type { ExecutionId } from '@shared/schemas';
import { generateExecutionId } from '@utils/core/executionId';
import { applyHelperModelPreference } from './helperModelPreference';
import { executeAgent } from './executeAgent';
import type { AgentRuntimeHost } from './AgentRuntimeHost';
import type { AgentFlowResult, WorkflowFlowResult } from './AgentFlowResult';
import type { AgentRunHandle } from './executionRegistry';
import type { ModelHandlerCompatibilityKey } from './modelHandlerCompatibilityKey';
import type { SessionHandle } from './SessionHandle';

export interface RunAgentOptions {
  runtimeHost: AgentRuntimeHost;
  openWorkflowOutput?: (result: WorkflowFlowResult) => Promise<void>;
  enforceCategory?: boolean;
  registerExecution?: boolean;
  stopAfterCycle?: boolean;
  approvalPromptsUnavailable?: boolean;
  runtimeUnavailableTools?: readonly string[];
  /**
   * Per-run override for the host's tool-edit approval UI — see
   * `ExecuteAgentOptions.toolEditApprovalHandler`.
   */
  toolEditApprovalHandler?: ToolEditApprovalPort;
  /**
   * Opt-in set by the "fix LaTeX" VS Code actions (Fix-Compilation command, the
   * progress-view compile fixer): run the launched agent on the configured
   * helper model instead of the selected one. Off for a direct main-view launch,
   * the CLI, and orchestrator delegations, which all keep the chosen model.
   */
  preferHelperModel?: boolean;
  /** Session owning this run's coordination state. Defaults to the process session. */
  session?: SessionHandle;
  /** Resume using this persisted provider-message format instead of today's default route. */
  modelHandlerCompatibilityKey?: ModelHandlerCompatibilityKey | null;
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
